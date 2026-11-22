import { defineConfig, loadEnv } from 'vite';

function localDeviceSpecsPlugin() {
  return {
    name: 'local-device-specs-api',
    configureServer(server) {
      server.middlewares.use('/api/device-specs', async (req, res, next) => {
        try {
          const mod = await server.ssrLoadModule('/api/device-specs.js');
          await mod.default(req, res);
        } catch (err) {
          next(err);
        }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/device-specs', async (req, res, next) => {
        try {
          const mod = await import('./api/device-specs.js');
          await mod.default(req, res);
        } catch (err) {
          next(err);
        }
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
