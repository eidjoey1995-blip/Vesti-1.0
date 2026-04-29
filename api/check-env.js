export default function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY || "";
  return res.status(200).json({
    length: key.length,
    prefix: key.slice(0, 13),
    suffix_last_4: key.slice(-4),
    has_leading_whitespace: key !== key.trimStart(),
    has_trailing_whitespace: key !== key.trimEnd(),
    starts_with_quote: key.startsWith('"') || key.startsWith("'"),
    contains_newline: key.includes("\n") || key.includes("\r"),
    is_empty: key.length === 0,
    note: "Diagnostic endpoint — delete after debugging"
  });
}
