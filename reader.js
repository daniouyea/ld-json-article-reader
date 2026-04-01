const articleType = document.querySelector("#articleType");
const articleTitle = document.querySelector("#articleTitle");
const articleMeta = document.querySelector("#articleMeta");
const sourceLink = document.querySelector("#sourceLink");
const articleBody = document.querySelector("#articleBody");
const rawMetadata = document.querySelector("#rawMetadata");
let extensionConfig = null;

void initializeReader();

async function initializeReader() {
  extensionConfig = await loadFormattingConfig();

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");

  if (!id) {
    renderEmptyState("No article data was provided.");
    return;
  }

  const storageKey = `reader:${id}`;
  const stored = await chrome.storage.local.get(storageKey);
  const payload = stored[storageKey];

  if (!payload) {
    renderEmptyState("The selected article data is no longer available.");
    return;
  }

  renderArticle(payload);
}

function renderArticle(payload) {
  articleType.textContent = payload.primaryType || "Structured data result";
  articleTitle.textContent = payload.title || payload.headline || payload.name || "Untitled result";
  articleMeta.textContent = [payload.author, payload.publisher, payload.datePublished].filter(Boolean).join(" • ");

  if (payload.sourceUrl) {
    sourceLink.href = payload.sourceUrl;
  } else {
    sourceLink.hidden = true;
  }

  if (payload.hasArticleBody && payload.articleBody) {
    const blocks = splitIntoBlocks(payload.articleBody, extensionConfig.formatting);

    blocks.forEach((block, index) => {
      const blockElement = document.createElement(block.kind === "subtitle" ? "h2" : "p");
      blockElement.textContent = block.text;

      if (block.kind === "subtitle") {
        blockElement.classList.add("section-heading");
      } else if (index === 0 || block.lead) {
        blockElement.classList.add("lead");
      }

      articleBody.append(blockElement);
    });
    return;
  }

  rawMetadata.hidden = false;
  rawMetadata.textContent = payload.rawJsonPreview || "No metadata preview is available.";
  renderEmptyState("This match does not include articleBody. Raw metadata is shown instead.");
}

function renderEmptyState(message) {
  const messageElement = document.createElement("p");
  messageElement.className = "empty-message";
  messageElement.textContent = message;
  articleBody.append(messageElement);
}

async function loadFormattingConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL("article-reader.config.json"));

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  } catch {
    return {
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
}

function splitIntoBlocks(body, formattingConfig) {
  const normalized = body.replace(/\r\n/g, "\n").trim();

  if (!normalized) {
    return [];
  }

  const paragraphsFromBreaks = normalized
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

  if (paragraphsFromBreaks.length > 1) {
    return paragraphsFromBreaks.flatMap((paragraph, index) => mapParagraphToBlocks(paragraph, index === 0, formattingConfig));
  }

  const singleLineParagraphs = normalized
    .split(/\n+/)
    .map((paragraph) => paragraph.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);

  if (singleLineParagraphs.length > 1) {
    return singleLineParagraphs.flatMap((paragraph, index) => mapParagraphToBlocks(paragraph, index === 0, formattingConfig));
  }

  return buildBlocksFromFlatText(normalized.replace(/\s+/g, " ").trim(), formattingConfig);
}

function mapParagraphToBlocks(paragraph, isFirstBlock, formattingConfig) {
  if (looksLikeSubtitle(paragraph, formattingConfig)) {
    return [{ kind: "subtitle", text: paragraph }];
  }

  return [{ kind: "paragraph", text: paragraph, lead: isFirstBlock }];
}

function buildBlocksFromFlatText(text, formattingConfig) {
  const sentences = splitIntoSentences(text);

  if (sentences.length === 0) {
    return [];
  }

  const blocks = [];
  let currentParagraph = "";

  sentences.forEach((sentence) => {
    const normalizedSentence = sentence.trim();

    if (!normalizedSentence) {
      return;
    }

    if (looksLikeSubtitle(normalizedSentence, formattingConfig)) {
      pushParagraph();
      blocks.push({ kind: "subtitle", text: normalizedSentence });
      return;
    }

    const proposedParagraph = currentParagraph ? `${currentParagraph} ${normalizedSentence}` : normalizedSentence;
    const reachedIdealLength = currentParagraph.length >= formattingConfig.idealParagraphLength;
    const reachedMaxLength = proposedParagraph.length > formattingConfig.maxParagraphLength;

    if (currentParagraph && (reachedIdealLength || reachedMaxLength)) {
      pushParagraph();
    }

    currentParagraph = currentParagraph ? `${currentParagraph} ${normalizedSentence}` : normalizedSentence;
  });

  pushParagraph();
  return mergeShortParagraphs(blocks, formattingConfig.mergeShortParagraphThreshold).map((block, index) => ({
    ...block,
    lead: block.kind === "paragraph" && index === 0
  }));

  function pushParagraph() {
    if (!currentParagraph) {
      return;
    }

    blocks.push({ kind: "paragraph", text: currentParagraph.trim() });
    currentParagraph = "";
  }
}

function splitIntoSentences(text) {
  const parts = text.match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  return parts.map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function mergeShortParagraphs(blocks, threshold) {
  return blocks.reduce((merged, block) => {
    if (block.kind !== "paragraph") {
      merged.push(block);
      return merged;
    }

    const previous = merged[merged.length - 1];

    if (
      previous &&
      previous.kind === "paragraph" &&
      (previous.text.length < threshold || block.text.length < threshold)
    ) {
      previous.text = `${previous.text} ${block.text}`.replace(/\s+/g, " ").trim();
      return merged;
    }

    merged.push(block);
    return merged;
  }, []);
}

function looksLikeSubtitle(text, formattingConfig) {
  const cleaned = text.replace(/["'“”‘’]+/g, "").trim();

  if (!cleaned) {
    return false;
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  const endsAsSentence = /[.!?…:]$/.test(cleaned);
  const uppercaseRatio = getUppercaseWordRatio(words);
  const isCompact = cleaned.length <= formattingConfig.subtitleMaxLength && words.length <= formattingConfig.subtitleMaxWords;
  const titleCaseLike = uppercaseRatio >= formattingConfig.subtitleUppercaseRatio;

  if (isCompact && !endsAsSentence) {
    return true;
  }

  return isCompact && titleCaseLike;
}

function getUppercaseWordRatio(words) {
  const lexicalWords = words.filter((word) => /\p{L}/u.test(word));

  if (lexicalWords.length === 0) {
    return 0;
  }

  const uppercaseWords = lexicalWords.filter((word) => {
    const normalized = word.replace(/[^\p{L}]/gu, "");
    if (!normalized) {
      return false;
    }

    const firstChar = normalized.charAt(0);
    return firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase();
  });

  return uppercaseWords.length / lexicalWords.length;
}