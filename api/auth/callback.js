// api/auth/callback.js — GitHub OAuth 回调
const https = require('https');

function post(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

module.exports = async function handler(req, res) {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=auth_denied');

  try {
    const data = await post('https://github.com/login/oauth/access_token', {
      client_id:     process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    });
    if (!data.access_token) return res.redirect('/?error=token_failed');
    res.redirect(`/?token=${data.access_token}`);
  } catch(e) {
    res.redirect('/?error=server_error');
  }
};
