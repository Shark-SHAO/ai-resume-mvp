// api/github.js — 读取真实 GitHub 数据
// 环境变量: 无（token 由前端传入 Authorization header）

const https = require('https');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

function ghGet(path, token) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.github.com',
      path,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'AI-Resume-MVP/1.0',
        Accept: 'application/vnd.github.v3+json',
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

const AI_KW = [
  'ai','llm','gpt','claude','openai','langchain','vector','embedding','ml',
  'machine-learning','neural','transformer','agent','bot','assistant','rag',
  'diffusion','huggingface','pytorch','tensorflow','cursor','copilot','deepseek',
  'stable-diffusion','whisper','yolo','opencv','nlp','chatbot','generative',
];

function aiSignal(repo) {
  const text = [repo.name, repo.description||'', ...(repo.topics||[])].join(' ').toLowerCase();
  return AI_KW.filter(kw => text.includes(kw)).length;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'No token provided' });

  // 1. 用户信息
  const user = await ghGet('/user', token);
  if (!user || user.message) {
    return res.status(401).json({ error: 'GitHub token 无效或已过期，请重新授权' });
  }

  // 2. 公开仓库（最多100个）
  const [repos1, repos2] = await Promise.all([
    ghGet('/user/repos?sort=updated&per_page=100&type=public&visibility=public&page=1', token),
    ghGet('/user/repos?sort=updated&per_page=100&type=public&visibility=public&page=2', token),
  ]);
  const allRepos = [
    ...(Array.isArray(repos1) ? repos1 : []),
    ...(Array.isArray(repos2) ? repos2 : []),
  ].filter(r => !r.fork && !r.archived);

  // 3. 近期事件（获取活跃度和commit数）
  const events = await ghGet(`/users/${user.login}/events/public?per_page=100`, token);
  const pushEvents = Array.isArray(events) ? events.filter(e => e.type === 'PushEvent') : [];
  const recentCommitCount = pushEvents.reduce((s, e) => s + (e.payload?.commits?.length || 0), 0);

  // 计算活跃天数（去重）
  const activeDaysSet = new Set(
    pushEvents.map(e => e.created_at?.slice(0, 10)).filter(Boolean)
  );

  // 4. 语言统计（前15个仓库）
  const topRepos = allRepos.slice(0, 15);
  const langResults = await Promise.all(
    topRepos.map(r => ghGet(`/repos/${r.full_name}/languages`, token))
  );
  const langTotals = {};
  langResults.forEach(lang => {
    if (!lang || typeof lang !== 'object') return;
    Object.entries(lang).forEach(([k, v]) => { langTotals[k] = (langTotals[k] || 0) + v; });
  });
  const topLanguages = Object.entries(langTotals)
    .sort(([,a],[,b]) => b - a)
    .slice(0, 5)
    .map(([k]) => k);

  // 5. 汇总统计
  const totalStars = allRepos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
  const totalForks = allRepos.reduce((s, r) => s + (r.forks_count || 0), 0);

  // 6. 给每个仓库打 AI 信号分
  const reposWithSignal = allRepos.map(r => ({
    name: r.name,
    full_name: r.full_name,
    description: r.description || '',
    language: r.language || '',
    stargazers_count: r.stargazers_count || 0,
    forks_count: r.forks_count || 0,
    topics: r.topics || [],
    homepage: r.homepage || '',
    updated_at: r.updated_at,
    ai_signal: aiSignal(r),
  }));

  const stats = {
    activeDays: activeDaysSet.size,
    commitCount: recentCommitCount,
    langCount: Object.keys(langTotals).length,
    topLanguages,
    totalStars,
    forks: totalForks,
    followers: user.followers || 0,
    aiRepoCount: reposWithSignal.filter(r => r.ai_signal > 0).length,
  };

  return res.status(200).json({
    user: {
      login: user.login,
      name: user.name || user.login,
      avatar_url: user.avatar_url,
      bio: user.bio || '',
      followers: user.followers || 0,
      public_repos: user.public_repos || 0,
      html_url: user.html_url,
    },
    repos: reposWithSignal,
    stats,
    languages: langTotals,
  });
};
