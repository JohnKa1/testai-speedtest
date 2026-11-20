import { defineConfig, loadEnv } from 'vite';
import deviceSpecsHandler from './api/device-specs.js';

function localDeviceSpecsPlugin() {
  return {
    name: 'local-device-specs-api',
    configureServer(server) {
      server.middlewares.use('/api/device-specs', (req, res) => {
        deviceSpecsHandler(req, res);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/device-specs', (req, res) => {
        deviceSpecsHandler(req, res);
      });
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (env.MOBILEAPI_KEY && !process.env.MOBILEAPI_KEY) {
    process.env.MOBILEAPI_KEY = env.MOBILEAPI_KEY;
  }

  return {
    base: './',
    plugins: [localDeviceSpecsPlugin()]
  };
});