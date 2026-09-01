'use strict';
const path = require('path');
const { P, readJSON, listDir, statSafe } = require('./paths.cjs');

// ~/.claude/usage-data/session-meta/<id>.json  -> metricas por sesion
// ~/.claude/usage-data/facets/<id>.json        -> analisis semantico (objetivo,
//                                                 resultado, satisfaccion, friccion)
// Las escribe el propio Claude Code; no todas las sesiones tienen facets.

function readMeta() {
  const map = new Map();
  for (const f of listDir(P.sessionMeta)) {
    if (!f.isFile() || !f.name.endsWith('.json')) continue;
    const d = readJSON(path.join(P.sessionMeta, f.name), null);
    if (!d) continue;
    const id = d.session_id || f.name.replace(/\.json$/, '');
    map.set(id, {
      sessionId: id,
      projectPath: d.project_path || null,
      startTime: d.start_time || null,
      durationMinutes: d.duration_minutes || 0,
      userMessages: d.user_message_count || 0,
      assistantMessages: d.assistant_message_count || 0,
      toolCounts: d.tool_counts || {},
      languages: d.languages || {},
      gitCommits: d.git_commits || 0,
      gitPushes: d.git_pushes || 0,
      inputTokens: d.input_tokens || 0,
      outputTokens: d.output_tokens || 0,
      firstPrompt: d.first_prompt || null,
      interruptions: d.user_interruptions || 0,
      responseTimes: d.user_response_times || [],
      toolErrors: d.tool_errors || 0,
      toolErrorCategories: d.tool_error_categories || {},
      usesTaskAgent: !!d.uses_task_agent,
      usesMcp: !!d.uses_mcp,
      usesWebSearch: !!d.uses_web_search,
      usesWebFetch: !!d.uses_web_fetch,
      linesAdded: d.lines_added || 0,
      linesRemoved: d.lines_removed || 0,
      filesModified: d.files_modified || 0,
      messageHours: d.message_hours || [],
    });
  }
  return map;
}

function readFacets() {
  const map = new Map();
  for (const f of listDir(P.facets)) {
    if (!f.isFile() || !f.name.endsWith('.json')) continue;
    const d = readJSON(path.join(P.facets, f.name), null);
    if (!d) continue;
    const id = f.name.replace(/\.json$/, '');
    map.set(id, {
      sessionId: id,
      underlyingGoal: d.underlying_goal || null,
      goalCategories: d.goal_categories || {},
      outcome: d.outcome || null,
      satisfaction: d.user_satisfaction_counts || {},
      helpfulness: d.claude_helpfulness || null,
      sessionType: d.session_type || null,
      friction: d.friction_counts || {},
    });
  }
  return map;
}

function reports() {
  return listDir(P.usageData)
    .filter((f) => f.isFile() && f.name.endsWith('.html'))
    .map((f) => {
      const full = path.join(P.usageData, f.name);
      const st = statSafe(full);
      return { file: f.name, path: full, mtimeMs: st ? st.mtimeMs : 0, sizeBytes: st ? st.size : 0 };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readAll() {
  return { meta: readMeta(), facets: readFacets(), reports: reports() };
}

module.exports = { readAll, readMeta, readFacets, reports };
