const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function setupProxy(app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'http://localhost:4000',
      changeOrigin: true,
      logLevel: 'warn',
    })
  );

  app.use(
    '/scmt-proxy',
    createProxyMiddleware({
      target: 'https://apigw.telkom.co.id:7777',
      changeOrigin: true,
      secure: false,
      pathRewrite: {
        '^/scmt-proxy': '',
      },
      logLevel: 'warn',
    })
  );
};
