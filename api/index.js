'use strict';
// Vercel Serverless Function：/api/* をすべて server.js のハンドラへ渡す
const { handler } = require('../server');

module.exports = (req, res) => handler(req, res);
