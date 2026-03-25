export default async function handler(req, res) {
  const { code, error: oauthError } = req.query;

  if (oauthError || !code) {
    return res.redirect(`/?error=${oauthError || 'missing_code'}`);
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const data = await tokenRes.json();
    if (data.error || !data.access_token) {
      return res.redirect(`/?error=${data.error || 'token_failed'}`);
    }

    // Token in hash — stays client-side, not sent to any server
    return res.redirect(`/#gh_token=${data.access_token}`);
  } catch {
    return res.redirect('/?error=server_error');
  }
}
