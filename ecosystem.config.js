// PM2 process manager configuration
// Usage: pm2 start ecosystem.config.js

module.exports = {
  apps: [
    {
      name: 'd2f-api',
      script: 'server.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '500M',
      error_file: './logs/pm2-api-error.log',
      out_file: './logs/pm2-api-out.log',
    },
    {
      name: 'd2f-workers',
      script: 'jobs.worker-entry.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '500M',
      error_file: './logs/pm2-workers-error.log',
      out_file: './logs/pm2-workers-out.log',
    },
  ],
};
