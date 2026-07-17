const CryptoJS = require('crypto-js');
const env = require('./config.env');

const KEY = env.tokenEncryptionKey;

function encrypt(plainText) {
  if (plainText === null || plainText === undefined) return null;
  return CryptoJS.AES.encrypt(String(plainText), KEY).toString();
}

function decrypt(cipherText) {
  if (!cipherText) return null;
  const bytes = CryptoJS.AES.decrypt(cipherText, KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

module.exports = { encrypt, decrypt };
