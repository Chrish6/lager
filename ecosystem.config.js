module.exports = {
  apps: [{
    name: "lager",
    script: "server.cjs",
    node_args: "--max-old-space-size=4096",
    max_memory_restart: "2G",
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: "production",
    },
  }],
};
