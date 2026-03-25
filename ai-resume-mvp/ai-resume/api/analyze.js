/* ─── ACI Scoring Engine ──────────────────────────────────────────────────── */

const QUIZ_SCORE_MAP = {
  // [dimension]: [q_index, ...] — raw option score 1-4
  d1: [4],           // model selection
  d2: [0, 1, 5],     // tool freq, ai code%, code review
  d3: [1, 5],        // ai code%, code review
  d4: [2, 6],        // prompt strategy, context mgmt
  d5: [3],           // app building
  d6: [7],           // community
};

const DIM_MAX = { d1: 500, d2: 600, d3: 500, d4: 400, d5: 380, d6: 150 };

function quizScore(answers, dim) {
  const indices = QUIZ_SCORE_MAP[dim];
  const raw = indices.reduce((s, i) => s + (answers[i] ?? 1), 0) / indices.length; // 1-4
  return Math.round(((raw - 1) / 3) * DIM_MAX[dim]);
}

function githubScore(stats, repos) {
  const s = stats || {};
  const r = repos || [];

  // D2 — coding tool proficiency (activity × diversity)
  const d2 = Math.min(
    600,
    Math.round(
      (s.activeDays / 25) * 300 +
      Math.min(s.languageDiversity / 8, 1) * 150 +
      Math.min(s.commitCount / 80, 1) * 150
    )
  );

  // D3 — AI-enhanced code contribution
  const d3 = Math.min(
    500,
    Math.round(
      s.aiRepoRatio * 300 +
      Math.min(s.aiRepoCount / 5, 1) * 120 +
      (s.topLanguages?.includes('Jupyter Notebook') ? 80 : 0)
    )
  );

  // D5 — app building (deployed projects × stars)
  const d5 = Math.min(
    380,
    Math.round(
      Math.min(s.deployedApps / 5, 1) * 200 +
      Math.min(s.totalStars / 50, 1) * 100 +
      Math.min(r.filter(rp => rp.stargazers_count > 5).length / 5, 1) * 80
    )
  );

  // D6 — influence (followers + stars)
  const d6 = Math.min(
    150,
    Math.round(Math.min(s.totalStars / 20, 1) * 80 + Math.min((s.followers || 0) / 100, 1) * 70)
  );

  return { d2, d3, d5, d6 };
}

function mergeDims(quizAnswers, ghScores) {
  // Quiz-dominated: D1, D4 (behavioral, GitHub can't measure)
  // GitHub-dominated: D2, D3, D5, D6 (objective)
  // Blend when both available
  const q = (dim) => quizScore(quizAnswers, dim);
  const g = (dim) => ghScores[dim];

  const blend = (qVal, gVal, qW) =>
    Math.round(qVal * qW + gVal * (1 - qW));

  return {
    d1: q('d1'),                         // quiz only
    d2: blend(q('d2'), g('d2'), 0.35),   // 35% quiz, 65% GitHub
    d3: blend(q('d3'), g('d3'), 0.3),    // 30% quiz, 70% GitHub
    d4: q('d4'),                         // quiz only
    d5: blend(q('d5'), g('d5'), 0.4),    // 40% quiz, 60% GitHub
    d6: blend(q('d6'), g('d6'), 0.4),    // 40% quiz, 60% GitHub
  };
}

/* ─── Rule-based project scoring (fallback) ──────────────────────────────── */

const AI_KW = [
  'ai','llm','gpt','claude','openai','langchain','vector','embedding',
  'ml','machine-learning','neural','transformer','agent','bot','assistant',
  'rag','diffusion','huggingface','pytorch','tensorflow','cursor','copilot',
];

function ruleProjectScore(repo) {
  const text = [repo.name, repo.description || '', ...(repo.topics || [])]
    .join(' ').toLowerCase();

  let aiScore = 0;
  const matched = AI_KW.filter((kw) => text.includes(kw));
  aiScore += matched.length * 12;
  if (repo.language === 'Jupyter Notebook') aiScore += 20;
  if (repo.language === 'Python') aiScore += 8;
  if (repo.stargazers_count > 0) aiScore += Math.min(repo.stargazers_count * 2, 20);
  if (repo.homepage) aiScore += 10;

  return {
    name: repo.name,
    description: repo.description || '暂无描述',
    language: repo.language || 'Unknown',
    stars: repo.stargazers_count,
    aiScore: Math.min(aiScore, 100),
    aiKeywords: matched.slice(0, 3),
    highlight: matched.length > 0
      ? `包含 AI 相关技术：${matched.slice(0, 3).join(', ')}`
      : repo.stars > 5
      ? `社区认可：${repo.stargazers_count} ⭐`
      : '优质开源项目',
    homepage: repo.homepage || null,
  };
}

/* ─── DeepSeek API call (OpenAI-compatible) ──────────────────────────────── */

async function callDeepSeek(apiKey, githubData, quizAnswers, dims, aci) {
  const { user, repos, stats, readmes } = githubData;

  const repoSummary = repos
    .slice(0, 20)
    .map(
      (r) =>
        `- ${r.name} [${r.language || '?'}] ⭐${r.stargazers_count} topics:[${(r.topics || []).join(',')}] "${r.description || ''}"`
    )
    .join('\n');

  const readmeSummary = readmes
    .slice(0, 4)
    .map((r) => `=== ${r.repo} README ===\n${r.content.slice(0, 400)}`)
    .join('\n\n');

  const prompt = `你是 AI Resume 的 AI 能力分析引擎，专门评估开发者的 AI 使用能力。

## 用户数据
GitHub 用户：${user.name || user.login}
公开仓库数：${user.public_repos}，近30天活跃天数：${stats.activeDays}，AI相关仓库：${stats.aiRepoCount}/${repos.length}
主要语言：${stats.topLanguages?.join(', ')}，总 Stars：${stats.totalStars}

## 仓库列表
${repoSummary}

## 部分 README
${readmeSummary || '（无）'}

## ACI 评分结果
总分：${aci}，D1 模型调用力：${dims.d1}/500，D2 编程工具：${dims.d2}/600，D3 AI代码贡献：${dims.d3}/500，D4 Prompt工程：${dims.d4}/400，D5 应用构建：${dims.d5}/380，D6 影响力：${dims.d6}/150

## 任务
1. 从仓库列表中，选出最能体现 AI 能力的 TOP 3-5 个项目，评估每个项目的 AI 含量（0-100分）和质量
2. 写一段3-4句的 ACI 能力分析（直接、专业、有具体洞察，提及具体仓库名，不要泛泛而谈）
3. 写一条最具体可操作的提升建议（针对最弱维度）

只返回以下 JSON 格式，不要任何 markdown 代码块或额外文字：
{
  "projects": [
    {
      "name": "仓库名",
      "description": "一句话描述项目是做什么的",
      "language": "主要语言",
      "stars": 数字,
      "aiScore": 0-100的数字,
      "highlight": "这个项目体现AI能力的亮点，一句话，具体",
      "aiKeywords": ["关键词1","关键词2"]
    }
  ],
  "analysis": "能力分析段落",
  "tip": "提升建议"
}`;

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 1500,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: '你是 AI Resume 的分析引擎。只输出 JSON，不输出任何 markdown 代码块或额外解释。',
        },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty DeepSeek response');

  // Strip markdown fences if model adds them anyway
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(clean);
}

/* ─── Handler ─────────────────────────────────────────────────────────────── */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { githubData, quizAnswers } = req.body;

    const ghRaw = githubScore(githubData?.stats, githubData?.repos);
    const dims = mergeDims(quizAnswers, ghRaw);

    const weights = { d1: 0.2, d2: 0.25, d3: 0.2, d4: 0.15, d5: 0.15, d6: 0.05 };
    const aci = Math.round(
      Object.keys(dims).reduce((s, k) => s + dims[k] * weights[k], 0)
    );

    const apiKey = process.env.DEEPSEEK_API_KEY;

    let projects, analysis;

    if (apiKey && githubData?.repos?.length > 0) {
      try {
        const dsResult = await callDeepSeek(apiKey, githubData, quizAnswers, dims, aci);
        projects = dsResult.projects;
        analysis = { analysis: dsResult.analysis, tip: dsResult.tip };
      } catch (e) {
        console.error('DeepSeek failed, using fallback:', e.message);
      }
    }

    // Fallback: rule-based project scoring
    if (!projects) {
      projects = (githubData?.repos || [])
        .map(ruleProjectScore)
        .sort((a, b) => b.aiScore - a.aiScore)
        .slice(0, 5)
        .filter((p) => p.aiScore > 0 || p.stars > 0);
    }

    // Fallback: rule-based analysis text
    if (!analysis) {
      const weakest = Object.entries(dims).sort((a, b) => a[1] / DIM_MAX[a[0]] - b[1] / DIM_MAX[b[0]])[0][0];
      const weakNames = { d1:'模型选择策略', d2:'编程工具使用深度', d3:'AI辅助代码贡献', d4:'Prompt工程能力', d5:'应用构建与部署', d6:'社区影响力' };
      analysis = {
        analysis: `你的 ACI 总分 ${aci}，基于 GitHub 真实数据和行为问卷综合评定。在 ${stats?.topLanguages?.[0] || '主力语言'} 开发方向上有一定积累，${stats?.aiRepoCount > 0 ? `检测到 ${stats.aiRepoCount} 个 AI 相关项目` : '尚无明显 AI 相关项目记录'}。整体处于 AI 工具使用者阶段，具备进一步提升为 AI Builder 的基础。`,
        tip: `当前最大提升杠杆在「${weakNames[weakest]}」——建议从这里开始，每周投入 2-3 小时专项练习，4周内可以看到显著进步。`,
      };
    }

    res.json({ dims, aci, projects, analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
