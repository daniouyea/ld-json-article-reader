const state = {
  loading: false,
  candidates: [],
  activeUrl: "",
  hostname: "",
  config: null
};

const scanButton = document.querySelector("#scanButton");
const statusText = document.querySelector("#statusText");
const resultCount = document.querySelector("#resultCount");
const resultsContainer = document.querySelector("#resultsContainer");
const resultCardTemplate = document.querySelector("#resultCardTemplate");

document.addEventListener("DOMContentLoaded", () => {
  scanButton.addEventListener("click", () => {
    void scanActiveTab();
  });

  void initializePopup();
});

async function initializePopup() {
  try {
    state.config = await loadExtensionConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateStatus(`Config load failed: ${message}`);
    state.config = createDefaultConfig();
  }

  await scanActiveTab();
}

async function scanActiveTab() {
  if (state.loading) {
    return;
  }

  state.loading = true;
  updateStatus("Scanning the current tab for LD+JSON article data...");
  renderResults();

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id || !tab.url) {
      throw new Error("No active tab is available.");
    }

    const pageUrl = new URL(tab.url);
    state.activeUrl = tab.url;
    state.hostname = pageUrl.hostname;

    const [executionResult] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractLdJsonNodes
    });

    const payload = executionResult?.result ?? { candidates: [], scriptCount: 0, parseErrors: [] };

    state.candidates = rankCandidates(payload.candidates, state.hostname, state.config?.ranking);

    if (state.candidates.length === 0) {
      updateStatus(
        `Scanned ${payload.scriptCount} LD+JSON script${payload.scriptCount === 1 ? "" : "s"}, but no usable article text was found.`
      );
    } else {
      const leadingCandidate = state.candidates[0];
      const recommendation = leadingCandidate.hasArticleBody
        ? `Recommended match: ${leadingCandidate.primaryType || "Structured data node"}.`
        : "Matches found, but none include articleBody yet.";

      updateStatus(
        `Scanned ${payload.scriptCount} LD+JSON script${payload.scriptCount === 1 ? "" : "s"} and found ${state.candidates.length} match${state.candidates.length === 1 ? "" : "es"}. ${recommendation}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.candidates = [];
    updateStatus(`Scan failed: ${message}`);
  } finally {
    state.loading = false;
    renderResults();
  }
}

function updateStatus(message) {
  statusText.textContent = message;
}

function renderResults() {
  resultCount.textContent = String(state.candidates.length);
  resultsContainer.textContent = "";

  if (state.candidates.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = state.loading
      ? "Reading the active page and collecting LD+JSON blocks..."
      : "Run a scan to inspect LD+JSON blocks and choose a result to open in the reader.";
    resultsContainer.append(emptyState);
    return;
  }

  state.candidates.forEach((candidate, index) => {
    const fragment = resultCardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".result-card");
    const badge = fragment.querySelector(".result-badge");
    const script = fragment.querySelector(".result-script");
    const title = fragment.querySelector(".result-title");
    const meta = fragment.querySelector(".result-meta");
    const preview = fragment.querySelector(".result-preview");
    const resultJson = fragment.querySelector(".result-json");
    const openButton = fragment.querySelector(".open-button");

    if (index === 0) {
      card.classList.add("recommended");
    }

    badge.textContent = candidate.primaryType || "Unknown type";
    script.textContent = `Script ${candidate.scriptIndex + 1} • ${candidate.path}`;
    title.textContent = candidate.title || candidate.headline || candidate.name || "Untitled metadata node";
    meta.textContent = buildMetaLine(candidate);
    preview.textContent = candidate.preview;
    resultJson.textContent = candidate.rawJsonPreview;

    openButton.disabled = state.loading;
    openButton.textContent = candidate.hasArticleBody ? "Open reader" : "Open metadata view";
    openButton.addEventListener("click", () => {
      void openReader(candidate);
    });

    resultsContainer.append(fragment);
  });
}

function buildMetaLine(candidate) {
  const parts = [];

  if (candidate.author) {
    parts.push(candidate.author);
  }

  if (candidate.publisher) {
    parts.push(candidate.publisher);
  }

  if (candidate.datePublished) {
    parts.push(candidate.datePublished);
  }

  if (candidate.hasArticleBody) {
    parts.push(`${candidate.articleBody.length.toLocaleString()} characters`);
  } else {
    parts.push("No articleBody field");
  }

  return parts.join(" • ");
}

async function openReader(candidate) {
  updateStatus(`Opening ${candidate.title || candidate.primaryType || "selected result"} in the reader...`);

  const response = await chrome.runtime.sendMessage({
    type: "open-reader",
    payload: {
      ...candidate,
      sourceUrl: state.activeUrl,
      hostname: state.hostname
    }
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Could not open the reader.");
  }
}

function rankCandidates(candidates, hostname, rankingConfig) {
  return [...candidates]
    .map((candidate) => ({
      ...candidate,
      score: getCandidateScore(candidate, hostname, rankingConfig)
    }))
    .sort((left, right) => right.score - left.score);
}

function getCandidateScore(candidate, hostname, rankingConfig) {
  const config = rankingConfig || createDefaultConfig().ranking;
  const typeList = candidate.types.map((type) => type.toLowerCase());
  const baseScores = config.baseScores || {};
  const typeScores = config.typeScores || {};
  const siteProfiles = Array.isArray(config.siteProfiles) ? config.siteProfiles : [];
  let score = 0;

  if (candidate.hasArticleBody) {
    score += baseScores.hasArticleBody || 0;
  }

  if (candidate.title || candidate.headline || candidate.name) {
    score += baseScores.hasTitle || 0;
  }

  if (candidate.author) {
    score += baseScores.hasAuthor || 0;
  }

  if (candidate.publisher) {
    score += baseScores.hasPublisher || 0;
  }

  if (candidate.datePublished) {
    score += baseScores.hasDatePublished || 0;
  }

  if (candidate.description) {
    score += baseScores.hasDescription || 0;
  }

  typeList.forEach((type) => {
    score += typeScores[type] || 0;
  });

  siteProfiles.forEach((profile) => {
    if (!matchesSiteProfile(hostname, profile)) {
      return;
    }

    score += getSiteProfileScore(candidate, typeList, profile);
  });

  return score;
}

function matchesSiteProfile(hostname, profile) {
  const includeHostnames = Array.isArray(profile?.includeHostnames) ? profile.includeHostnames : [];

  if (includeHostnames.length === 0) {
    return false;
  }

  return includeHostnames.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
}

function getSiteProfileScore(candidate, typeList, profile) {
  let score = 0;
  const preferredTypes = Array.isArray(profile?.preferredTypes) ? profile.preferredTypes.map((type) => type.toLowerCase()) : [];
  const bonus = Number(profile?.preferredTypeBonus) || 0;

  if (preferredTypes.some((type) => typeList.includes(type))) {
    score += bonus;
  }

  if (profile?.requireArticleBody && candidate.hasArticleBody) {
    score += Number(profile.requireArticleBodyBonus) || 0;
  }

  return score;
}

async function loadExtensionConfig() {
  const response = await fetch(chrome.runtime.getURL("article-reader.config.json"));

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function createDefaultConfig() {
  return {
    ranking: {
      baseScores: {
        hasArticleBody: 100,
        hasTitle: 12,
        hasAuthor: 6,
        hasPublisher: 4,
        hasDatePublished: 4,
        hasDescription: 5
      },
      typeScores: {
        article: 30,
        newsarticle: 30,
        opinionnewsarticle: 30,
        reportagearticle: 26,
        analysisnewsarticle: 26,
        webpage: 18,
        blogposting: 18
      },
      siteProfiles: []
    },
    formatting: {
      idealParagraphLength: 420,
      maxParagraphLength: 620,
      minParagraphLength: 140,
      subtitleMaxLength: 90,
      subtitleMaxWords: 10,
      subtitleUppercaseRatio: 0.72,
      mergeShortParagraphThreshold: 90
    }
  };
}

function extractLdJsonNodes() {
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  const candidates = [];
  const parseErrors = [];

  scripts.forEach((script, scriptIndex) => {
    const text = script.textContent?.trim();

    if (!text) {
      return;
    }

    try {
      const parsedValue = JSON.parse(text);
      const visited = new WeakSet();
      const nodes = [];
      collectNodes(parsedValue, "$", visited, nodes);

      nodes.forEach(({ value, path }) => {
        const types = toTypeList(value["@type"]);
        const articleBody = toText(value.articleBody);
        const title = toText(value.headline) || toText(value.name);
        const description = toText(value.description);
        const previewSource = articleBody || description || title || path;

        if (!types.length && !articleBody && !title && !description) {
          return;
        }

        candidates.push({
          scriptIndex,
          path,
          types,
          primaryType: types[0] || "",
          title,
          headline: toText(value.headline),
          name: toText(value.name),
          description,
          articleBody,
          hasArticleBody: Boolean(articleBody),
          author: readPersonName(value.author),
          publisher: readPublisherName(value.publisher),
          datePublished: toText(value.datePublished),
          url: toText(value.url) || toText(value.mainEntityOfPage),
          preview: previewSource.slice(0, 220).replace(/\s+/g, " "),
          rawJsonPreview: JSON.stringify(value, null, 2)
        });
      });
    } catch (error) {
      parseErrors.push({
        scriptIndex,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return {
    scriptCount: scripts.length,
    parseErrors,
    candidates
  };

  function collectNodes(value, path, visited, nodes) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (visited.has(value)) {
      return;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        collectNodes(item, `${path}[${index}]`, visited, nodes);
      });
      return;
    }

    nodes.push({ value, path });

    Object.entries(value).forEach(([key, childValue]) => {
      if (!childValue || typeof childValue !== "object") {
        return;
      }

      collectNodes(childValue, `${path}.${key}`, visited, nodes);
    });
  }

  function toText(value) {
    if (typeof value === "string") {
      return value.trim();
    }

    if (Array.isArray(value)) {
      return value.map(toText).filter(Boolean).join(" ").trim();
    }

    if (value && typeof value === "object") {
      return toText(value.name || value.text || value["@id"] || "");
    }

    return "";
  }

  function toTypeList(value) {
    if (typeof value === "string") {
      return [value];
    }

    if (Array.isArray(value)) {
      return value.flatMap((entry) => toTypeList(entry)).filter(Boolean);
    }

    return [];
  }

  function readPersonName(authorValue) {
    if (Array.isArray(authorValue)) {
      return authorValue.map(readPersonName).filter(Boolean).join(", ");
    }

    return toText(authorValue);
  }

  function readPublisherName(publisherValue) {
    return toText(publisherValue);
  }
}