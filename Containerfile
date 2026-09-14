FROM docker.io/library/node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9655 \
    NON_INTERACTIVE=1 \
    DEEPSEEK_AUTH_PATH=/run/secrets/deepseek-auth.json \
    PROXY_API_KEY_FILE=/run/secrets/proxy-api-key \
    REQUIRE_PROXY_API_KEY=1

WORKDIR /app

# FreeDeepseekAPI has no npm dependencies. Copy only the files needed by the
# non-interactive proxy; browser auth helpers and credentials stay on the host.
COPY --chown=1000:1000 package.json server.js ./
COPY --chown=1000:1000 lib/pow.js ./lib/pow.js

USER 1000:1000

EXPOSE 9655

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "const http=require('http');const req=http.get({host:'127.0.0.1',port:process.env.PORT||9655,path:'/health'},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1)})"]

CMD ["node", "server.js"]
