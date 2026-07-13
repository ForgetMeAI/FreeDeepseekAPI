'use strict';

/**
 * toolcall_normalizer.js
 * ----------------------
 * Deterministic parser that normalizes DeepSeek Web's NATIVE tool-call format
 * into clean OpenAI-compatible { name, arguments } tool calls.
 *
 * Vendored into FreeDeepseekAPI to fix a gap: the upstream parseToolCall()
 * only handled strict-JSON / fenced-JSON / <tool_call>{...}</tool_call> (JSON
 * body) / legacy TOOL_CALL:, but DeepSeek Web itself emits function calls in a
 * different native XML shape with <parameter name="..."> children:
 *
 *   <tool_call name="todo_write">
 *     <parameter name="todos">[{"id":"1",...}]</parameter>
 *   </tool_call>
 *
 * The upstream parser tried JSON.parse on the XML body, failed, and fell back
 * to plain text. This module adds a FAST-PATH that parses that exact native
 * shape (plus the other variants) into a real { name, arguments } object.
 *
 * ORIGINAL upstream proxy (credits / license):
 *   ForgetMeAI/FreeDeepseekAPI  -  https://github.com/ForgetMeAI/FreeDeepseekAPI
 *   Author: ForgetMeAI (t.me/forgetmeai)  -  MIT licensed.
 *
 * This normalizer is a companion drop-in patch, not a fork replacement.
 */

/**
 * Coerce an unknown value into { name, arguments } where arguments is a
 * stringified JSON object. Handles common LLM wrapper shapes.
 */
function coerceToolCallObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const candidate = obj.tool_call || obj.tool || obj.function_call || obj;
  if (!candidate || typeof candidate !== 'object') return null;
  const fn = candidate.function && typeof candidate.function === 'object' ? candidate.function : candidate;
  const name = fn.name || candidate.name || obj.name;
  if (!name || typeof name !== 'string') return null;
  let args = fn.arguments ?? candidate.arguments ?? candidate.input ?? obj.arguments ?? obj.input ?? {};
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch (e) { args = { raw: args }; }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = { value: args };
  return { name, arguments: JSON.stringify(args) };
}

/**
 * Parse a single <parameter name="X">VALUE</parameter> value.
 * VALUE may be JSON (object/array/number/bool) or a plain string.
 */
function parseParameterValue(raw) {
  const text = raw.trim();
  if (text === '') return '';
  try { return JSON.parse(text); } catch (e) { /* not JSON */ }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/**
 * Parse the native DeepSeek Web XML tool-call:
 *   <tool_call name="NAME">
 *     <parameter name="P1">V1</parameter>
 *     ...
 *   </tool_call>
 * Returns { name, arguments: <object> } or null.
 */
function parseNativeXml(tag) {
  const nameMatch = tag.match(/<tool_call\s+name\s*=\s*["']([^"']+)["']/i)
    || tag.match(/name\s*=\s*["']([^"']+)["']/i);
  const name = nameMatch ? nameMatch[1] : null;
  if (!name) return null;

  const args = {};
  const paramRe = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
  let m;
  let found = false;
  while ((m = paramRe.exec(tag)) !== null) {
    found = true;
    args[m[1]] = parseParameterValue(m[2]);
  }

  // Single generic param whose value is already an object/array -> promote.
  const keys = Object.keys(args);
  if (keys.length === 1) {
    const only = keys[0];
    const generic = /^(input|arguments|argument|value|params|parameters|body|content)$/i.test(only);
    if (generic && args[only] && typeof args[only] === 'object') {
      return { name, arguments: args[only] };
    }
  }

  return { name, arguments: found ? args : {} };
}

/** Extract balanced JSON starting at index i (handles nested braces/strings). */
function extractBalancedJsonAt(text, startIndex) {
  let braceDepth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{' || ch === '[') braceDepth++;
      else if (ch === '}' || ch === ']') {
        braceDepth--;
        if (braceDepth === 0) {
          const slice = text.substring(startIndex, i + 1);
          try { return JSON.parse(slice); } catch (e) { return null; }
        }
      }
    }
  }
  return null;
}

function parseJsonToolCandidate(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    return coerceToolCallObject(parsed);
  } catch (e) { return null; }
}

/**
 * Main entry: normalize raw model text into a tool call.
 * @param {string} text
 * @returns {{name:string, arguments:object}|null}
 */
function normalizeToolCall(text) {
  if (!text || typeof text !== 'string') return null;

  // 1) Native DeepSeek Web XML
  const xmlMatch = text.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
  if (xmlMatch) {
    const native = parseNativeXml(xmlMatch[0]);
    if (native && native.name) return native;
  }

  // 2) Fenced JSON
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fence;
  while ((fence = fenceRe.exec(text)) !== null) {
    const tc = parseJsonToolCandidate(fence[1].trim());
    if (tc) return { name: tc.name, arguments: safeParse(tc.arguments) };
  }

  // 3) Legacy TOOL_CALL: name
  const legacy = text.match(/TOOL_CALL:\s*([\w-]+)\s*/i);
  if (legacy) {
    const name = legacy[1];
    const after = text.substring(legacy.index + legacy[0].length);
    const braceIdx = after.indexOf('{');
    if (braceIdx !== -1) {
      const obj = extractBalancedJsonAt(after, braceIdx);
      if (obj) return { name, arguments: obj };
    }
  }

  // 4) First balanced JSON object
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    const obj = extractBalancedJsonAt(text, i);
    if (!obj || typeof obj !== 'object') continue;
    if (obj.tool_call || obj.tool || obj.function_call || obj.name) {
      const tc = coerceToolCallObject(obj);
      if (tc) return { name: tc.name, arguments: safeParse(tc.arguments) };
    }
  }

  return null;
}

function safeParse(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch (e) { return s; }
}

function isToolCall(text) {
  return normalizeToolCall(text) !== null;
}

module.exports = { normalizeToolCall, isToolCall, parseNativeXml, parseParameterValue };
