export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const gh = (path) =>
    fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'AI-Resume-MVP/1.0',
        Accept: 'application/vnd.github.v3+json',
      },
    });

  try {
    const [userRes, reposRes, eventsRes] = await Promise.all([
      gh('/user'),
      gh('/user/repos?sort=updated&per_page=50&type=owner&visibility=public'),
      gh('/user/events?per_page=100'),
    ]);

    const [user, repos, events] = await Promise.all([
      userRes.json(), reposRes.json(), eventsRes.json(),
    ]);

    if (user.message === 'Bad credentials') {
      return res.status(401).json({ error: 'Invalid GitHub token' });
    }

    const repoList = Array.isArray(repos) ? repos : [];
    const eventList = Array.isArray(events) ? events : [];

    // Fetch READMEs for top 8 repos by stars
    const topRepos = [...repoList]
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .slice(0, 8);

    const readmes = (
      await Promise.all(
        topRepos.map(async (repo) => {
          try {
            const r = await gh(`/repos/${repo.full_name}/readme`);
            if (!r.ok) return null;
            const d = await r.json();
            if (!d.content) return null;
            const decoded = Buffer.from(d.content, 'base64').toString('utf8').slice(0, 1200);
            return { repo: repo.name, content: decoded };
          } catch {
            return null;
          }
        })
      )
    ).filter(Boolean);

    // Push event stats
    const pushEvents = eventList.filter((e) => e.type === 'PushEvent');
    const commitCount = pushEvents.reduce(
      (s, e) => s + (e.payload?.commits?.length || 0), 0
    );
    const activeDays = new Set(pushEvents.map((e) => e.created_at?.slice(0, 10))).size;

    // Language distribution
    const langMap = {};
    repoList.forEach((r) => {
      if (r.language) langMap[r.language] = (langMap[r.language] || 0) + 1;
    });
    const topLanguages = Object.entries(langMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([l]) => l);

    // AI-related repos detection
    const AI_KEYWORDS = [
      'ai', 'llm', 'gpt', 'claude', 'openai', 'anthropic', 'langchain',
      'vector', 'embedding', 'ml', 'machine-learning', 'deep-learning',
      'neural', 'transformer', 'chatgpt', 'cursor', 'copilot', 'rag',
      'agent', 'bot', 'assistant', 'stable-diffusion', 'diffusion',
      'huggingface', 'pytorch', 'tensorflow',
    ];

    const aiRepos = repoList.filter((r) => {
      const text = [
        r.name, r.description || '', ...(r.topics || []),
      ].join(' ').toLowerCase();
      return AI_KEYWORDS.some((kw) => text.includes(kw));
    });

    res.json({
      user: {
        login: user.login,
        name: user.name || user.login,
        avatar_url: user.avatar_url,
        public_repos: user.public_repos,
        followers: user.followers,
        created_at: user.created_at,
        bio: user.bio,
      },
      repos: repoList.map((r) => ({
        name: r.name,
        full_name: r.full_name,
        description: r.description,
        language: r.language,
        stargazers_count: r.stargazers_count,
        forks_count: r.forks_count,
        topics: r.topics || [],
        updated_at: r.updated_at,
        homepage: r.homepage,
      })),
      stats: {
        commitCount,
        activeDays,
        topLanguages,
        totalStars: repoList.reduce((s, r) => s + r.stargazers_count, 0),
        languageDiversity: Object.keys(langMap).length,
        aiRepoCount: aiRepos.length,
        aiRepoRatio: repoList.length > 0 ? aiRepos.length / repoList.length : 0,
        deployedApps: repoList.filter((r) => r.homepage).length,
      },
      readmes,
    });
  } catch (err) {
    res.status(500).json({ error: 'GitHub fetch failed', details: err.message });
  }
}
