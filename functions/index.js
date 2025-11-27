// functions/index.js

const admin = require('firebase-admin');
admin.initializeApp();

// API들을 기능별로 로드
const profileApi = require('./api/profile');
const simplificationApi = require('./api/simplification');
const dictionaryApi = require('./api/dictionary');
const recommendationApi = require('./api/recommendation'); // Added this line

// 모든 API 함수들을 한번에 export
module.exports = {
  ...profileApi,
  ...simplificationApi,
  ...dictionaryApi,
  ...recommendationApi, // Added this line
};