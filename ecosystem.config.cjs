module.exports = {
  apps: [{
    name: 'deepseek-api',
    script: 'server.js',
    cwd: __dirname,
    env: {
      NON_INTERACTIVE: '1',
      PORT: '9655',
    },
  }],
};
