const { app } = require('../server');

const handler = (req, res) => app(req, res);

module.exports = handler;
module.exports.default = handler;
