// content/content.js — GEO Analyzer
// Listens for RUN_ANALYSIS message, extracts all page data and responds.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RUN_ANALYSIS') {
    try {
      const pageData = extractPageData();
      sendResponse({ success: true, pageData });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  }
  return true;
});

function extractPageData() {
  const mainEl =
    document.querySelector('main') ||
    document.querySelector('article') ||
    document.querySelector('[role="main"]') ||
    document.body;

  const cloned = mainEl.cloneNode(true);
  cloned.querySelectorAll('script,style,nav,footer,header,aside,[aria-hidden="true"]')
    .forEach(el => el.remove());
  const bodyText = cloned.innerText.replace(/\s+/g, ' ').trim();

  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(el => ({
    level: parseInt(el.tagName[1]),
    text: el.innerText.trim()
  }));

  const schemas = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
    try {
      const parsed = JSON.parse(script.textContent);
      if (Array.isArray(parsed)) schemas.push(...parsed);
      else schemas.push(parsed);
    } catch (_) {}
  });

  const meta = {};
  document.querySelectorAll('meta').forEach(m => {
    const key = m.getAttribute('property') || m.getAttribute('name');
    if (key) meta[key] = m.getAttribute('content') || '';
  });

  const host = location.hostname;
  const externalLinks = [...document.querySelectorAll('a[href]')]
    .map(a => { try { return new URL(a.href); } catch { return null; } })
    .filter(u => u && u.hostname && u.hostname !== host && u.protocol.startsWith('http'))
    .map(u => u.href);

  const internalLinks = [...document.querySelectorAll('a[href]')]
    .map(a => { try { return new URL(a.href); } catch { return null; } })
    .filter(u => u && u.hostname === host)
    .map(u => u.href);

  const images = [...document.querySelectorAll('img')].map(img => ({
    src: img.src,
    alt: img.alt || '',
    hasAlt: (img.alt || '').trim().length > 0
  }));

  const ulCount = document.querySelectorAll('ul').length;
  const olCount = document.querySelectorAll('ol').length;
  const tableCount = document.querySelectorAll('table').length;

  const sectionTexts = [];
  let cur = '';
  cloned.querySelectorAll('h2,h3,p').forEach(el => {
    if (el.tagName === 'H2') { if (cur.trim()) sectionTexts.push(cur.trim()); cur = ''; }
    else cur += ' ' + (el.innerText || '');
  });
  if (cur.trim()) sectionTexts.push(cur.trim());

  const paragraphs = [...cloned.querySelectorAll('p')]
    .map(p => p.innerText.trim()).filter(t => t.length > 20);
  const avgParaWords = paragraphs.length > 0
    ? paragraphs.reduce((s, p) => s + p.split(/\s+/).length, 0) / paragraphs.length : 0;

  const wordList = bodyText.split(/\s+/).filter(Boolean);
  const wordCount = wordList.length;
  const sentences = bodyText.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
  const sentenceCount = Math.max(sentences.length, 1);
  const syllableCount = countSyllables(bodyText);

  let lcp = null;
  try {
    if (typeof PerformanceObserver !== 'undefined' &&
        PerformanceObserver.supportedEntryTypes?.includes('largest-contentful-paint')) {
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      if (lcpEntries.length > 0) lcp = lcpEntries[lcpEntries.length - 1].startTime;
    }
  } catch (_) {}

  const isProduct = !!(document.querySelector('[itemprop="price"]') || document.querySelector('.product-price') || meta['og:type'] === 'product');
  const isArticle = !!(document.querySelector('article') || document.querySelector('[itemprop="articleBody"]') || meta['og:type'] === 'article' || schemas.some(s => ['Article','BlogPosting','NewsArticle'].includes(s['@type'])));
  const isLocal = schemas.some(s => s['@type'] === 'LocalBusiness');

  const authorSelectors = ['[rel="author"]','.author','.byline','[itemprop="author"]','[class*="author"]','[class*="byline"]','.post-author'];
  const hasAuthor = authorSelectors.some(s => { const el = document.querySelector(s); return el && el.innerText.trim().length > 0; }) || !!meta['author'];
  const bioSelectors = ['.author-bio','.author-description','[class*="author-bio"]','[class*="about-author"]','.contributor-bio'];
  const hasAuthorBio = bioSelectors.some(s => !!document.querySelector(s));

  const dateStr =
    meta['article:modified_time'] || meta['article:published_time'] ||
    meta['dateModified'] || meta['datePublished'] ||
    (schemas.find(s => s.dateModified || s.datePublished) || {}).dateModified ||
    (schemas.find(s => s.dateModified || s.datePublished) || {}).datePublished || '';

  const AUTHORITY = [/\.gov(\/|$)/,/\.edu(\/|$)/,/pubmed\.ncbi/,/who\.int/,/nature\.com/,/reuters\.com/,/apnews\.com/,/wikipedia\.org/,/scholar\.google/,/ncbi\.nlm\.nih/,/sciencedirect\.com/,/springer\.com/,/bmj\.com/,/nejm\.org/];
  const authoritativeLinks = externalLinks.filter(href => AUTHORITY.some(p => p.test(href)));

  const tocSelectors = ['.table-of-contents','#toc','.toc','[class*="table-of-contents"]','[id*="table-of-contents"]'];
  const hasToc = tocSelectors.some(s => !!document.querySelector(s));
  const boldCount = document.querySelectorAll('strong,b').length;
  const calloutSelectors = ['.callout','.highlight-box','.info-box','.note','[class*="callout"]','blockquote'];
  const hasCallouts = calloutSelectors.some(s => !!document.querySelector(s));

  const allSents = bodyText.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 30);
  const uniqueSents = new Set(allSents);
  const duplicateRatio = allSents.length > 0 ? 1 - uniqueSents.size / allSents.length : 0;

  const statPattern = /\b\d{4}\b|\d+%|\$[\d,.]+|\b\d+(?:\.\d+)?\s*(million|billion|thousand|trillion)\b/gi;
  const statMatches = (bodyText.match(statPattern) || []).length;

  const questionHeadings = headings.filter(h => /^(what|how|why|when|where|can|is|are|do|does|which|who)\b/i.test(h.text));
  const questionHeadingRatio = headings.length > 0 ? questionHeadings.length / headings.length : 0;

  let directAnswerCount = 0;
  sectionTexts.forEach(s => {
    const first = s.split(/\s+/).slice(0, 20).join(' ');
    if (/^(the |a |an |to |in |for |yes|no |[A-Z][a-z]+ (is|are|was|were|has|have|can|will))/i.test(first.trim())) directAnswerCount++;
  });

  const passivePattern = /\b(is|are|was|were|be|been|being)\s+(being\s+)?\w+ed\b/gi;
  const passiveMatches = (bodyText.match(passivePattern) || []).length;
  const passiveRatio = wordCount > 0 ? passiveMatches / (wordCount / 100) : 0;

  const longWordCount = wordList.filter(w => countWordSyllables(w) >= 4).length;
  const jargonRatio = wordCount > 0 ? longWordCount / wordCount : 0;

  const defPattern = /\b(means?|refers? to|defined? as|is a |is an |also known as|i\.e\.|that is)\b/gi;
  const definitionCount = (bodyText.match(defPattern) || []).length;

  return {
    bodyText, wordCount, pageTitle: document.title,
    headings, paragraphs, avgParaWords, sectionTexts,
    listItems: document.querySelectorAll('li').length, ulCount, olCount, tableCount, hasToc, boldCount, hasCallouts,
    schemas, meta,
    metaDesc: meta['description'] || '',
    metaDescLength: (meta['description'] || '').length,
    hasCanonical: !!document.querySelector('link[rel="canonical"]'),
    hasOgTitle: !!meta['og:title'], hasOgDescription: !!meta['og:description'],
    hasOgImage: !!meta['og:image'], hasTwitterCard: !!meta['twitter:card'],
    hasViewport: !!document.querySelector('meta[name="viewport"]'),
    hasAuthor, hasAuthorBio, dateStr,
    externalLinks, internalLinks, authoritativeLinks,
    statMatches, duplicateRatio,
    questionHeadings, questionHeadingRatio, directAnswerCount,
    passiveRatio, jargonRatio, definitionCount, images,
    isProduct, isArticle, isLocal,
    readabilityStats: { words: wordCount, sentences: sentenceCount, syllables: syllableCount },
    lcp, isHttps: location.protocol === 'https:'
  };
}

function countSyllables(text) {
  return text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean)
    .reduce((s, w) => s + countWordSyllables(w), 0);
}
function countWordSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = word.match(/[aeiouy]{1,2}/g);
  return m ? Math.max(1, m.length) : 1;
}
