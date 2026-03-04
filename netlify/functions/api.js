const serverless = require('serverless-http');
const app = require('../../backend/server.cjs');

exports.handler = serverless(app);
