const crud = require('./crud');
const state = require('./state');

module.exports = {
  ...crud,
  ...state,
};
