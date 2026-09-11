// demo/broken.js — deliberately invalid JS. Fetchable at this path but
// never loaded via a <script> tag, so it can't break the demo page itself.
// Exists only to exercise the `parses` check's fail path.
function oops( {
  return "missing closing paren above, and no closing brace here either";
