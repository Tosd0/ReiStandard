/**
 * @typedef {Object} ProtectedPattern
 * @property {RegExp} pattern
 * @property {string | ((raw: string, match: RegExpMatchArray) => string)} [preview]
 * @property {unknown | ((raw: string, match: RegExpMatchArray) => unknown)} [meta]
 */

/**
 * @typedef {Object} SegmentTextOptions
 * @property {ProtectedPattern[]} [protectedPatterns]
 * @property {(text: string) => string[]} splitText
 * @property {(text: string) => string} [sanitizeText]
 */

/**
 * @typedef {Object} PushTextSegment
 * @property {string} raw
 * @property {string} sanitized
 * @property {boolean} protect
 * @property {unknown} [meta]
 */

/**
 * Segments text while protecting specific blocks from being split.
 * This is useful when the output needs to be split for streaming or chunking,
 * but certain segments (e.g. Markdown code blocks, HTML tags) must be kept intact.
 *
 * @param {string} text
 * @param {SegmentTextOptions} options
 * @returns {PushTextSegment[]}
 */
export function segmentTextWithProtectedBlocks(text, options) {
  if (!text) return [];

  const splitAndSanitize = (plainText) => {
    const chunks = options.splitText(plainText).filter(c => c !== '');
    return chunks.map(chunk => ({
      raw: chunk,
      sanitized: options.sanitizeText ? options.sanitizeText(chunk) : chunk,
      protect: false
    }));
  };

  if (!options.protectedPatterns || options.protectedPatterns.length === 0) {
    return splitAndSanitize(text);
  }

  const matches = [];

  for (const p of options.protectedPatterns) {
    // Clone the regex to ensure we can iterate globally
    const flags = p.pattern.flags.includes('g') ? p.pattern.flags : p.pattern.flags + 'g';
    const regex = new RegExp(p.pattern.source, flags);
    
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      matches.push({
        index: match.index,
        length: match[0].length,
        raw: match[0],
        matchObj: match,
        patternDef: p
      });
    }
  }

  // Sort by earliest match first, then by longest match
  matches.sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    return b.length - a.length;
  });

  // Resolve overlaps
  const validMatches = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.index >= lastEnd) {
      validMatches.push(m);
      lastEnd = m.index + m.length;
    }
  }

  const segments = [];
  let cursor = 0;

  const resolveField = (field, raw, match) => typeof field === 'function' ? field(raw, match) : field;

  for (const m of validMatches) {
    if (m.index > cursor) {
      const plainText = text.substring(cursor, m.index);
      segments.push(...splitAndSanitize(plainText));
    }

    const previewStr = resolveField(m.patternDef.preview, m.raw, m.matchObj);
    const metaData = resolveField(m.patternDef.meta, m.raw, m.matchObj);

    let sanitized = previewStr;
    if (sanitized == null) {
      sanitized = options.sanitizeText ? options.sanitizeText(m.raw) : m.raw;
    }

    const pushSeg = {
      raw: m.raw,
      sanitized,
      protect: true
    };
    if (metaData !== undefined) {
      pushSeg.meta = metaData;
    }
    segments.push(pushSeg);

    cursor = m.index + m.length;
  }

  if (cursor < text.length) {
    const plainText = text.substring(cursor);
    segments.push(...splitAndSanitize(plainText));
  }

  return segments;
}
