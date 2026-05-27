// background/background.js
// Service worker: orchestrates analysis, runs all 36 rules, caches results

const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ANALYZE_TAB') {
    handleAnalysis(msg.tabId, msg.url)
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === 'CLEAR_CACHE') {
    const key = `geo_cache_${msg.url}`;
    chrome.storage.local.remove(key, () => sendResponse({ success: true }));
    return true;
  }
});

async function handleAnalysis(tabId, url) {
  // Check cache
  const cacheKey = `geo_cache_${url}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey] && Date.now() - cached[cacheKey].timestamp < CACHE_DURATION_MS) {
    return { ...cached[cacheKey].result, fromCache: true };
  }

  // Get page data from content script
  const pageData = await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: 'RUN_ANALYSIS' }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.success) return reject(new Error(response?.error || 'Analysis failed'));
      resolve(response.pageData);
    });
  });

  // Run all rules
  const ruleResults = runAllRules(pageData);

  // Compute score
  const score = computeScore(ruleResults);

  const result = {
    score,
    ruleResults,
    pageData: {
      title: pageData.pageTitle,
      wordCount: pageData.wordCount,
      url
    },
    analyzedAt: Date.now()
  };

  // Cache result
  await chrome.storage.local.set({ [cacheKey]: { result, timestamp: Date.now() } });

  return result;
}

function runAllRules(pageData) {
  return RULES.map(rule => {
    try {
      const { pass, detail } = rule.check(pageData);
      return { rule, pass, detail };
    } catch (err) {
      return { rule, pass: 'partial', detail: `Check error: ${err.message}` };
    }
  });
}

function computeScore(ruleResults) {
  let totalEarned = 0;
  let totalPossible = 0;
  const byCategory = {};

  ruleResults.forEach(({ rule, pass, detail }) => {
    const earned = pass === true ? rule.points : pass === 'partial' ? rule.points * 0.5 : 0;
    totalEarned += earned;
    totalPossible += rule.points;
    if (!byCategory[rule.category]) byCategory[rule.category] = { earned: 0, possible: 0, results: [] };
    byCategory[rule.category].earned += earned;
    byCategory[rule.category].possible += rule.points;
    byCategory[rule.category].results.push({ rule, pass, detail });
  });

  const total = Math.min(100, Math.round((totalEarned / totalPossible) * 100));
  const grade = total >= 90 ? 'A+' : total >= 80 ? 'A' : total >= 70 ? 'B' : total >= 60 ? 'C' : total >= 50 ? 'D' : 'F';
  const gradeColor = total >= 70 ? '#10b981' : total >= 50 ? '#f59e0b' : '#ef4444';

  const allIssues = ruleResults
    .filter(r => r.pass !== true)
    .sort((a, b) => {
      const o = { false: 0, partial: 1 };
      return (o[String(a.pass)] - o[String(b.pass)]) || (b.rule.points - a.rule.points);
    });

  return {
    total,
    grade,
    gradeColor,
    totalEarned: Math.round(totalEarned * 10) / 10,
    totalPossible,
    byCategory,
    allIssues,
    passing: ruleResults.filter(r => r.pass === true)
  };
}

// ── All 36 GEO Rules (inlined for service worker context) ─────────────────────

const RULES = [

  // ═══ CATEGORY 1: CONTENT QUALITY & DEPTH (25 pts) ═══════════════════════════

  { id: 'word_count', category: 'content', label: 'Sufficient word count (800+)', points: 4,
    check(d) {
      if (d.wordCount >= 800) return { pass: true, detail: `${d.wordCount.toLocaleString()} words — good depth` };
      if (d.wordCount >= 400) return { pass: 'partial', detail: `${d.wordCount} words — aim for 800+ for AI visibility` };
      return { pass: false, detail: `Only ${d.wordCount} words. Thin content ranks poorly in AI engines. Target 800+.` };
    }
  },

  { id: 'factual_density', category: 'content', label: 'Factual claims & statistics present', points: 4,
    check(d) {
      if (d.statMatches >= 5) return { pass: true, detail: `${d.statMatches} data points found (numbers, percentages, figures)` };
      if (d.statMatches >= 2) return { pass: 'partial', detail: `Only ${d.statMatches} statistics found — add more specific numbers and percentages` };
      return { pass: false, detail: 'No statistics or factual data detected. AI models prefer content with citable facts.' };
    }
  },

  { id: 'faq_structure', category: 'content', label: 'FAQ or question-based structure', points: 3,
    check(d) {
      const hasFaqSchema = d.schemas.some(s => s['@type'] === 'FAQPage');
      const qCount = d.questionHeadings.length;
      if (hasFaqSchema && qCount >= 3) return { pass: true, detail: `FAQ schema + ${qCount} question headings — great for AI snippet extraction` };
      if (qCount >= 3) return { pass: 'partial', detail: `${qCount} question headings found but no FAQPage schema markup` };
      if (hasFaqSchema) return { pass: 'partial', detail: 'FAQPage schema present but few question-style headings in content' };
      return { pass: false, detail: 'Add FAQ section with "What is…", "How to…" headings and FAQPage schema markup.' };
    }
  },

  { id: 'paragraph_depth', category: 'content', label: 'Paragraph depth (avg 80+ words/section)', points: 3,
    check(d) {
      const avg = Math.round(d.avgParaWords);
      if (d.avgParaWords >= 80) return { pass: true, detail: `Average ${avg} words per paragraph` };
      if (d.avgParaWords >= 40) return { pass: 'partial', detail: `Average ${avg} words/paragraph — expand sections with more explanation` };
      return { pass: false, detail: `Very short paragraphs (avg ${avg} words). AI models prefer substantive, well-developed content.` };
    }
  },

  { id: 'unique_content', category: 'content', label: 'No thin or duplicate content', points: 3,
    check(d) {
      const pct = Math.round(d.duplicateRatio * 100);
      if (d.duplicateRatio < 0.1) return { pass: true, detail: `Content is ${100 - pct}% unique sentences` };
      if (d.duplicateRatio < 0.25) return { pass: 'partial', detail: `${pct}% sentence repetition detected — reduce boilerplate` };
      return { pass: false, detail: `High repetition detected (${pct}% duplicate sentences). AI engines flag this as low-quality.` };
    }
  },

  { id: 'meta_description', category: 'content', label: 'Meta description (150–160 chars)', points: 3,
    check(d) {
      if (d.metaDescLength >= 120 && d.metaDescLength <= 160) return { pass: true, detail: `Meta description is ${d.metaDescLength} chars — ideal length` };
      if (d.metaDescLength >= 50 && d.metaDescLength < 120) return { pass: 'partial', detail: `Meta description is ${d.metaDescLength} chars — expand to 150–160 for best results` };
      if (d.metaDescLength > 160) return { pass: 'partial', detail: `Meta description is ${d.metaDescLength} chars — trim to under 160` };
      return { pass: false, detail: 'No meta description found. AI engines use this for context about your page.' };
    }
  },

  { id: 'image_coverage', category: 'content', label: 'Images with descriptive alt text', points: 3,
    check(d) {
      const total = d.images.length;
      if (total === 0) return { pass: 'partial', detail: 'No images found — visual content improves engagement' };
      const withAlt = d.images.filter(img => img.hasAlt).length;
      const ratio = withAlt / total;
      if (ratio >= 0.9) return { pass: true, detail: `${withAlt}/${total} images have alt text` };
      if (ratio >= 0.5) return { pass: 'partial', detail: `Only ${withAlt}/${total} images have alt text — AI reads alt text for context` };
      return { pass: false, detail: `${total - withAlt} images missing alt text. Alt text helps AI understand your content.` };
    }
  },

  { id: 'internal_links', category: 'content', label: 'Internal links for content depth', points: 2,
    check(d) {
      const count = d.internalLinks.length;
      if (count >= 5) return { pass: true, detail: `${count} internal links — good topical coverage` };
      if (count >= 2) return { pass: 'partial', detail: `${count} internal links — add more to demonstrate content breadth` };
      return { pass: false, detail: 'Very few internal links. Linking to related content signals topical authority to AI.' };
    }
  },

  // ═══ CATEGORY 2: E-E-A-T SIGNALS (20 pts) ═══════════════════════════════════

  { id: 'author_byline', category: 'eeat', label: 'Author byline present', points: 4,
    check(d) {
      if (d.hasAuthor) return { pass: true, detail: 'Author attribution found on page' };
      return { pass: false, detail: 'No author byline found. AI models weight authorship heavily for trust signals.' };
    }
  },

  { id: 'author_bio', category: 'eeat', label: 'Author bio or credentials section', points: 3,
    check(d) {
      if (d.hasAuthorBio) return { pass: true, detail: 'Author bio / credentials section found' };
      if (d.hasAuthor) return { pass: 'partial', detail: 'Author named but no bio found — add credentials, title, or expertise' };
      return { pass: false, detail: 'No author bio found. Expertise signals help AI qualify your content as trustworthy.' };
    }
  },

  { id: 'publication_date', category: 'eeat', label: 'Publication / last-updated date', points: 3,
    check(d) {
      if (!d.dateStr) return { pass: false, detail: 'No publication date found. Add article:modified_time meta tag or schema dateModified.' };
      const date = new Date(d.dateStr);
      if (isNaN(date.getTime())) return { pass: 'partial', detail: 'Date tag present but could not parse the date value' };
      const monthsOld = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 30);
      if (monthsOld <= 6) return { pass: true, detail: `Updated ${Math.round(monthsOld)} months ago — content is fresh` };
      if (monthsOld <= 18) return { pass: 'partial', detail: `Last updated ${Math.round(monthsOld)} months ago — consider refreshing` };
      return { pass: false, detail: `Content is ${Math.round(monthsOld / 12)} year(s) old. AI engines deprioritize stale content.` };
    }
  },

  { id: 'authoritative_citations', category: 'eeat', label: 'Citations to authoritative sources', points: 5,
    check(d) {
      const count = d.authoritativeLinks.length;
      if (count >= 3) return { pass: true, detail: `${count} authoritative sources linked (.gov, .edu, research journals)` };
      if (count >= 1) return { pass: 'partial', detail: `Only ${count} authoritative link(s) — add more .gov, .edu, or research citations` };
      return { pass: false, detail: 'No links to authoritative sources (.gov, .edu, research journals). Citations signal expertise to AI.' };
    }
  },

  { id: 'brand_entity', category: 'eeat', label: 'Brand / org entity in schema', points: 3,
    check(d) {
      const orgSchema = d.schemas.find(s => ['Organization', 'LocalBusiness', 'Corporation', 'Brand', 'Person'].includes(s['@type']));
      if (orgSchema && orgSchema.name) return { pass: true, detail: `${orgSchema['@type']} schema found: "${orgSchema.name}"` };
      if (orgSchema) return { pass: 'partial', detail: 'Organization schema found but missing name property' };
      return { pass: false, detail: 'No Organization or Brand schema. AI uses this to identify who publishes the content.' };
    }
  },

  { id: 'external_link_count', category: 'eeat', label: 'External outbound links (3+ sources)', points: 2,
    check(d) {
      const count = d.externalLinks.length;
      if (count >= 3) return { pass: true, detail: `${count} external links — good reference coverage` };
      if (count >= 1) return { pass: 'partial', detail: `${count} external link(s) — add more supporting sources` };
      return { pass: false, detail: 'No external links found. Outbound citations demonstrate research depth.' };
    }
  },

  // ═══ CATEGORY 3: STRUCTURED DATA & MARKUP (20 pts) ══════════════════════════

  { id: 'schema_present', category: 'schema', label: 'Schema.org JSON-LD markup present', points: 4,
    check(d) {
      if (d.schemas.length === 0) return { pass: false, detail: 'No JSON-LD schema found. AI search engines parse schema.org markup directly.' };
      const types = d.schemas.map(s => s['@type']).filter(Boolean).join(', ');
      return { pass: true, detail: `${d.schemas.length} schema block(s): ${types}` };
    }
  },

  { id: 'schema_type_match', category: 'schema', label: 'Schema type matches content type', points: 4,
    check(d) {
      if (d.schemas.length === 0) return { pass: false, detail: 'No schema to evaluate — add schema.org JSON-LD first' };
      const types = d.schemas.map(s => s['@type']);
      if (d.isProduct && !types.includes('Product')) return { pass: 'partial', detail: 'Looks like a product page but no Product schema found' };
      if (d.isArticle && !types.some(t => ['Article', 'BlogPosting', 'NewsArticle'].includes(t))) return { pass: 'partial', detail: 'Article content detected but no Article/BlogPosting schema' };
      if (d.isLocal && !types.some(t => ['LocalBusiness', 'Store', 'Restaurant'].includes(t))) return { pass: 'partial', detail: 'Local business signals detected but no LocalBusiness schema' };
      return { pass: true, detail: 'Schema types appear to match the page content type' };
    }
  },

  { id: 'faq_schema', category: 'schema', label: 'FAQPage schema with Q&A pairs', points: 3,
    check(d) {
      const faqSchema = d.schemas.find(s => s['@type'] === 'FAQPage');
      if (!faqSchema) return { pass: false, detail: 'No FAQPage schema. AI engines extract FAQ schema directly for featured answers.' };
      const qas = faqSchema.mainEntity || [];
      if (qas.length >= 3) return { pass: true, detail: `FAQPage schema with ${qas.length} Q&A pairs` };
      return { pass: 'partial', detail: `FAQPage schema present but only ${qas.length} Q&A pairs — add at least 3` };
    }
  },

  { id: 'og_tags', category: 'schema', label: 'Open Graph meta tags (title, desc, image)', points: 3,
    check(d) {
      const has = [d.hasOgTitle, d.hasOgDescription, d.hasOgImage];
      const count = has.filter(Boolean).length;
      if (count === 3) return { pass: true, detail: 'All 3 Open Graph tags present (title, description, image)' };
      if (count >= 1) return { pass: 'partial', detail: `${count}/3 OG tags present — add: ${!d.hasOgTitle ? 'og:title ' : ''}${!d.hasOgDescription ? 'og:description ' : ''}${!d.hasOgImage ? 'og:image' : ''}`.trim() };
      return { pass: false, detail: 'No Open Graph tags found. Add og:title, og:description, og:image.' };
    }
  },

  { id: 'twitter_card', category: 'schema', label: 'Twitter/X Card meta tag', points: 2,
    check(d) {
      if (d.hasTwitterCard) return { pass: true, detail: 'Twitter Card meta tag present' };
      return { pass: false, detail: 'No twitter:card meta tag. Add twitter:card, twitter:title, twitter:description.' };
    }
  },

  { id: 'canonical_tag', category: 'schema', label: 'Canonical URL tag', points: 2,
    check(d) {
      if (d.hasCanonical) return { pass: true, detail: 'Canonical link tag present' };
      return { pass: false, detail: 'No canonical tag. Add <link rel="canonical" href="..."> to avoid duplicate content.' };
    }
  },

  { id: 'breadcrumb_schema', category: 'schema', label: 'BreadcrumbList schema', points: 2,
    check(d) {
      if (d.schemas.some(s => s['@type'] === 'BreadcrumbList')) return { pass: true, detail: 'BreadcrumbList schema found — helps AI understand site hierarchy' };
      return { pass: false, detail: 'No BreadcrumbList schema. Breadcrumbs help AI understand page context in site structure.' };
    }
  },

  // ═══ CATEGORY 4: FORMATTING & SCANNABILITY (15 pts) ═════════════════════════

  { id: 'h1_unique', category: 'formatting', label: 'Single unique H1 tag', points: 3,
    check(d) {
      const h1s = d.headings.filter(h => h.level === 1);
      if (h1s.length === 1) return { pass: true, detail: `H1: "${h1s[0].text.slice(0, 60)}${h1s[0].text.length > 60 ? '...' : ''}"` };
      if (h1s.length === 0) return { pass: false, detail: 'No H1 tag found. Every page needs exactly one H1 as the primary topic signal.' };
      return { pass: false, detail: `${h1s.length} H1 tags found — use exactly 1. Multiple H1s confuse AI topic extraction.` };
    }
  },

  { id: 'heading_hierarchy', category: 'formatting', label: 'H2/H3 heading structure', points: 3,
    check(d) {
      const h2s = d.headings.filter(h => h.level === 2);
      const h3s = d.headings.filter(h => h.level === 3);
      if (h2s.length >= 3) return { pass: true, detail: `${h2s.length} H2 sections${h3s.length > 0 ? `, ${h3s.length} H3 subsections` : ''}` };
      if (h2s.length >= 1) return { pass: 'partial', detail: `Only ${h2s.length} H2 section(s) — aim for 3+ to structure content for AI parsing` };
      return { pass: false, detail: 'No H2 subheadings. Structure content with clear sections — AI uses headings for topic extraction.' };
    }
  },

  { id: 'lists_used', category: 'formatting', label: 'Bullet and numbered lists present', points: 2,
    check(d) {
      const total = d.ulCount + d.olCount;
      if (total >= 2) return { pass: true, detail: `${d.ulCount} bullet list(s), ${d.olCount} numbered list(s) — good for AI extraction` };
      if (total === 1) return { pass: 'partial', detail: 'Only 1 list found — add more bullet or numbered lists for scannable content' };
      return { pass: false, detail: 'No lists found. Bullet points and numbered lists are easily extracted by AI for structured answers.' };
    }
  },

  { id: 'callout_boxes', category: 'formatting', label: 'Callouts or highlighted key points', points: 2,
    check(d) {
      if (d.hasCallouts) return { pass: true, detail: 'Callout or highlight boxes found — key info is surfaced clearly' };
      if (d.boldCount >= 5) return { pass: 'partial', detail: `${d.boldCount} bold elements found but no callout boxes — add highlighted key-takeaway blocks` };
      return { pass: false, detail: 'No callout boxes or bold highlights. Use blockquotes or highlight boxes for key takeaways.' };
    }
  },

  { id: 'table_of_contents', category: 'formatting', label: 'Table of contents (for long pages)', points: 2,
    check(d) {
      if (d.wordCount < 1000) return { pass: true, detail: 'Page is short enough that a TOC is not required' };
      if (d.hasToc) return { pass: true, detail: 'Table of contents found — helps AI and users navigate long content' };
      return { pass: 'partial', detail: `Page has ${d.wordCount} words but no table of contents. Add a TOC for long-form content.` };
    }
  },

  { id: 'reading_level', category: 'formatting', label: 'Reading level ≤ Grade 10 (Flesch-Kincaid)', points: 3,
    check(d) {
      const { words, sentences, syllables } = d.readabilityStats;
      if (words < 50) return { pass: 'partial', detail: 'Not enough text to calculate reading level' };
      const fkgl = (0.39 * (words / sentences)) + (11.8 * (syllables / words)) - 15.59;
      const grade = Math.max(1, Math.min(20, Math.round(fkgl * 10) / 10));
      if (grade <= 10) return { pass: true, detail: `Grade ${grade} reading level — accessible to most readers` };
      if (grade <= 13) return { pass: 'partial', detail: `Grade ${grade} reading level — simplify long sentences for broader AI comprehension` };
      return { pass: false, detail: `Grade ${grade} reading level is too complex. AI summarizes simpler content more accurately.` };
    }
  },

  { id: 'tables_used', category: 'formatting', label: 'Comparison tables for structured data', points: 3,
    check(d) {
      if (d.tableCount >= 1) return { pass: true, detail: `${d.tableCount} table(s) found — great for AI to extract comparative data` };
      if (d.wordCount >= 800) return { pass: 'partial', detail: 'No tables found — consider adding comparison tables for structured information' };
      return { pass: true, detail: 'Tables not required for this page length' };
    }
  },

  // ═══ CATEGORY 5: CONVERSATIONAL & AI-FRIENDLY (12 pts) ══════════════════════

  { id: 'direct_answers', category: 'conversational', label: 'Direct answers at section starts', points: 3,
    check(d) {
      const total = d.sectionTexts.length;
      if (total === 0) return { pass: 'partial', detail: 'Could not detect content sections to evaluate' };
      const ratio = d.directAnswerCount / total;
      if (ratio >= 0.6) return { pass: true, detail: `${d.directAnswerCount}/${total} sections lead with direct statements — ideal for AI snippet extraction` };
      if (ratio >= 0.3) return { pass: 'partial', detail: `Only ${d.directAnswerCount}/${total} sections have direct openers — lead with answers, not questions` };
      return { pass: false, detail: 'Sections do not start with direct answers. AI extracts leading sentences for featured snippets — front-load your answers.' };
    }
  },

  { id: 'question_headings', category: 'conversational', label: 'Question-style headings (What, How, Why)', points: 2,
    check(d) {
      const count = d.questionHeadings.length;
      if (count >= 3) return { pass: true, detail: `${count} question-style headings — matches conversational AI search queries` };
      if (count >= 1) return { pass: 'partial', detail: `${count} question heading(s) — add more "What is…", "How to…", "Why does…" headings` };
      return { pass: false, detail: 'No question-style headings. Use headings that mirror how users ask questions to AI.' };
    }
  },

  { id: 'active_voice', category: 'conversational', label: 'Active voice (low passive voice usage)', points: 3,
    check(d) {
      if (d.passiveRatio < 1.5) return { pass: true, detail: 'Low passive voice usage — content reads naturally and directly' };
      if (d.passiveRatio < 3) return { pass: 'partial', detail: 'Moderate passive voice detected — rewrite some sentences to active voice' };
      return { pass: false, detail: 'High passive voice usage detected. Active voice is clearer for AI comprehension. E.g., "We found X" not "X was found."' };
    }
  },

  { id: 'inline_definitions', category: 'conversational', label: 'Inline definitions of key terms', points: 2,
    check(d) {
      if (d.definitionCount >= 5) return { pass: true, detail: `${d.definitionCount} definition phrases found — terms are well explained` };
      if (d.definitionCount >= 2) return { pass: 'partial', detail: `${d.definitionCount} term definitions found — add more inline explanations of jargon` };
      return { pass: false, detail: 'No inline definitions detected. Define key terms in context — AI uses these for entity understanding.' };
    }
  },

  { id: 'jargon_density', category: 'conversational', label: 'Low jargon density (readable vocabulary)', points: 2,
    check(d) {
      const pct = Math.round(d.jargonRatio * 100);
      if (d.jargonRatio < 0.04) return { pass: true, detail: `Low jargon density (${pct}% complex words) — content is accessible` };
      if (d.jargonRatio < 0.08) return { pass: 'partial', detail: `Moderate jargon (${pct}% complex words) — simplify technical terms where possible` };
      return { pass: false, detail: `High jargon density (${pct}% complex words). Use simpler vocabulary — AI comprehends and summarizes plain language more reliably.` };
    }
  },

  // ═══ CATEGORY 6: TECHNICAL & FRESHNESS SIGNALS (8 pts) ══════════════════════

  { id: 'https_protocol', category: 'technical', label: 'HTTPS protocol', points: 1,
    check(d) {
      if (d.isHttps) return { pass: true, detail: 'Page served over HTTPS' };
      return { pass: false, detail: 'Page is served over HTTP. HTTPS is required for trust. AI engines prefer HTTPS sources.' };
    }
  },

  { id: 'page_speed', category: 'technical', label: 'Core Web Vitals — LCP under 2.5s', points: 2,
    check(d) {
      if (d.lcp === null) return { pass: 'partial', detail: 'LCP could not be measured (may not be available on this page type)' };
      const lcp = Math.round(d.lcp);
      if (lcp < 2500) return { pass: true, detail: `LCP: ${(lcp / 1000).toFixed(2)}s — excellent` };
      if (lcp < 4000) return { pass: 'partial', detail: `LCP: ${(lcp / 1000).toFixed(2)}s — needs improvement (target < 2.5s)` };
      return { pass: false, detail: `LCP: ${(lcp / 1000).toFixed(2)}s — poor. Slow pages are crawled less frequently by AI engines.` };
    }
  },

  { id: 'viewport_meta', category: 'technical', label: 'Mobile viewport meta tag', points: 2,
    check(d) {
      if (d.hasViewport) return { pass: true, detail: 'Viewport meta tag present — page is mobile-friendly' };
      return { pass: false, detail: 'No viewport meta tag. Add <meta name="viewport" content="width=device-width, initial-scale=1">.' };
    }
  },

  { id: 'content_freshness', category: 'technical', label: 'Content updated within last 12 months', points: 3,
    check(d) {
      if (!d.dateStr) return { pass: 'partial', detail: 'No date signal found — freshness cannot be verified' };
      const date = new Date(d.dateStr);
      if (isNaN(date.getTime())) return { pass: 'partial', detail: 'Date found but format is not parseable' };
      const monthsOld = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 30);
      if (monthsOld <= 12) return { pass: true, detail: `Content updated ${Math.round(monthsOld)} month(s) ago — fresh` };
      if (monthsOld <= 24) return { pass: 'partial', detail: `Content is ${Math.round(monthsOld)} months old — AI engines prefer recently updated content` };
      return { pass: false, detail: `Content is ${Math.round(monthsOld / 12)} year(s) old. Refresh and update with current information.` };
    }
  }

];
