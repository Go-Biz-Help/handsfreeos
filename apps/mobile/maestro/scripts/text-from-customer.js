// A customer's text reaching the business through the fake carrier: posted to the worker's inbound webhook the way
// Twilio posts one, signed with the fake carrier's own token (not a secret: apps/worker/src/telephony/fake.ts, and
// apps/web/e2e/telephony.ts signs the same way). The worker files it and pushes it to the people who should hear.
// FROM is the customer's number (E.164) and BODY the words; TO defaults to Lone Star's seeded number and WORKER_URL
// to the worker on this machine (a local run passes its own). Sets output.sid.
var worker = typeof WORKER_URL !== 'undefined' && WORKER_URL ? WORKER_URL : 'http://127.0.0.1:4100';
var to = typeof TO !== 'undefined' && TO ? TO : '+18335550100';
var FAKE_MASTER_SID = 'ACfakemasteraccount';
var FAKE_AUTH_TOKEN = 'fake-twilio-auth-token';

function utf8(text) {
  var bytes = [];
  var encoded = unescape(encodeURIComponent(text));
  for (var i = 0; i < encoded.length; i++) bytes.push(encoded.charCodeAt(i));
  return bytes;
}

function sha1(bytes) {
  var h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  var ml = bytes.length * 8;
  var msg = bytes.slice();
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  for (var s = 7; s >= 0; s--) msg.push(s >= 4 ? 0 : (ml >>> (s * 8)) & 0xff);
  var w = new Array(80);
  for (var off = 0; off < msg.length; off += 64) {
    for (var t = 0; t < 16; t++)
      w[t] =
        (msg[off + t * 4] << 24) |
        (msg[off + t * 4 + 1] << 16) |
        (msg[off + t * 4 + 2] << 8) |
        msg[off + t * 4 + 3];
    for (t = 16; t < 80; t++) {
      var x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }
    var a = h[0],
      b = h[1],
      c = h[2],
      d = h[3],
      e = h[4];
    for (t = 0; t < 80; t++) {
      var f, k;
      if (t < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      var temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
  }
  var out = [];
  for (var i = 0; i < 5; i++)
    out.push((h[i] >>> 24) & 0xff, (h[i] >>> 16) & 0xff, (h[i] >>> 8) & 0xff, h[i] & 0xff);
  return out;
}

function hmacSha1(key, message) {
  var k = key.length > 64 ? sha1(key) : key.slice();
  while (k.length < 64) k.push(0);
  var inner = [],
    outer = [];
  for (var i = 0; i < 64; i++) {
    inner.push(k[i] ^ 0x36);
    outer.push(k[i] ^ 0x5c);
  }
  return sha1(outer.concat(sha1(inner.concat(message))));
}

function base64(bytes) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63];
    out += i + 1 < bytes.length ? chars[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? chars[n & 63] : '=';
  }
  return out;
}

var sid =
  'SMfake' +
  Math.random()
    .toString(36)
    .replace(/[^a-z]/g, '') +
  Date.now()
    .toString(36)
    .replace(/[^a-z]/g, 'x');
var params = {
  AccountSid: FAKE_MASTER_SID,
  MessageSid: sid,
  From: FROM,
  To: to,
  Body: BODY,
  NumMedia: '0',
};
// Twilio signs the address it calls (the worker's own public address, 127.0.0.1 locally) followed by each parameter.
var signedUrl =
  (typeof SIGNED_URL !== 'undefined' && SIGNED_URL ? SIGNED_URL : worker) +
  '/webhooks/twilio/messaging/inbound';
var data = signedUrl;
var keys = Object.keys(params).sort();
for (var j = 0; j < keys.length; j++) data += keys[j] + params[keys[j]];
var form = keys
  .map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
  })
  .join('&');
var response = http.post(worker + '/webhooks/twilio/messaging/inbound', {
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': base64(hmacSha1(utf8(FAKE_AUTH_TOKEN), utf8(data))),
  },
  body: form,
});
if (response.status !== 200)
  throw new Error('The worker refused the text (' + response.status + ')');
output.sid = sid;
