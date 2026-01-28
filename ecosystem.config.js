module.exports = {
  apps: [{
    name: "backend",
    script: "./server.js",
    instances: "max",
    env: {
      NODE_ENV: "production",
    },
    watch: false,
    max_memory_restart: "1G",
    error_file: "./logs/error.log",
    out_file: "./logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss"
  }]
}