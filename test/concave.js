(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
'use strict';

var rbush = require('rbush');
var convexHull = require('monotone-convex-hull-2d');
var Queue = require('tinyqueue');
var pointInPolygon = require('point-in-polygon');
var orient = require('robust-orientation')[3];

module.exports = concaveman;
module.exports.default = concaveman;

function concaveman(points, concavity, lengthThreshold) {
    // a relative measure of concavity; higher value means simpler hull
    concavity = Math.max(0, concavity === undefined ? 2 : concavity);

    // when a segment goes below this length threshold, it won't be drilled down further
    lengthThreshold = lengthThreshold || 0;

    // start with a convex hull of the points
    var hull = fastConvexHull(points);

    // index the points with an R-tree
    var tree = rbush(16, ['[0]', '[1]', '[0]', '[1]']).load(points);

    // turn the convex hull into a linked list and populate the initial edge queue with the nodes
    var queue = [];
    for (var i = 0, last; i < hull.length; i++) {
        var p = hull[i];
        tree.remove(p);
        last = insertNode(p, last);
        queue.push(last);
    }

    // index the segments with an R-tree (for intersection checks)
    var segTree = rbush(16);
    for (i = 0; i < queue.length; i++) segTree.insert(updateBBox(queue[i]));

    var sqConcavity = concavity * concavity;
    var sqLenThreshold = lengthThreshold * lengthThreshold;

    // process edges one by one
    while (queue.length) {
        var node = queue.shift();
        var a = node.p;
        var b = node.next.p;

        // skip the edge if it's already short enough
        var sqLen = getSqDist(a, b);
        if (sqLen < sqLenThreshold) continue;

        var maxSqLen = sqLen / sqConcavity;

        // find the best connection point for the current edge to flex inward to
        p = findCandidate(tree, node.prev.p, a, b, node.next.next.p, maxSqLen, segTree);

        // if we found a connection and it satisfies our concavity measure
        if (p && Math.min(getSqDist(p, a), getSqDist(p, b)) <= maxSqLen) {
            // connect the edge endpoints through this point and add 2 new edges to the queue
            queue.push(node);
            queue.push(insertNode(p, node));

            // update point and segment indexes
            tree.remove(p);
            segTree.remove(node);
            segTree.insert(updateBBox(node));
            segTree.insert(updateBBox(node.next));
        }
    }

    // convert the resulting hull linked list to an array of points
    node = last;
    var concave = [];
    do {
        concave.push(node.p);
        node = node.next;
    } while (node !== last);

    concave.push(node.p);

    return concave;
}

function findCandidate(tree, a, b, c, d, maxDist, segTree) {
    var queue = new Queue(null, compareDist);
    var node = tree.data;

    // search through the point R-tree with a depth-first search using a priority queue
    // in the order of distance to the edge (b, c)
    while (node) {
        for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];

            var dist = node.leaf ? sqSegDist(child, b, c) : sqSegBoxDist(b, c, child);
            if (dist > maxDist) continue; // skip the node if it's farther than we ever need

            queue.push({
                node: child,
                dist: dist
            });
        }

        while (queue.length && !queue.peek().node.children) {
            var item = queue.pop();
            var p = item.node;

            // skip all points that are as close to adjacent edges (a,b) and (c,d),
            // and points that would introduce self-intersections when connected
            var d0 = sqSegDist(p, a, b);
            var d1 = sqSegDist(p, c, d);
            if (item.dist < d0 && item.dist < d1 &&
                noIntersections(b, p, segTree) &&
                noIntersections(c, p, segTree)) return p;
        }

        node = queue.pop();
        if (node) node = node.node;
    }

    return null;
}

function compareDist(a, b) {
    return a.dist - b.dist;
}

// square distance from a segment bounding box to the given one
function sqSegBoxDist(a, b, bbox) {
    if (inside(a, bbox) || inside(b, bbox)) return 0;
    var d1 = sqSegSegDist(a[0], a[1], b[0], b[1], bbox.minX, bbox.minY, bbox.maxX, bbox.minY);
    if (d1 === 0) return 0;
    var d2 = sqSegSegDist(a[0], a[1], b[0], b[1], bbox.minX, bbox.minY, bbox.minX, bbox.maxY);
    if (d2 === 0) return 0;
    var d3 = sqSegSegDist(a[0], a[1], b[0], b[1], bbox.maxX, bbox.minY, bbox.maxX, bbox.maxY);
    if (d3 === 0) return 0;
    var d4 = sqSegSegDist(a[0], a[1], b[0], b[1], bbox.minX, bbox.maxY, bbox.maxX, bbox.maxY);
    if (d4 === 0) return 0;
    return Math.min(d1, d2, d3, d4);
}

function inside(a, bbox) {
    return a[0] >= bbox.minX &&
           a[0] <= bbox.maxX &&
           a[1] >= bbox.minY &&
           a[1] <= bbox.maxY;
}

// check if the edge (a,b) doesn't intersect any other edges
function noIntersections(a, b, segTree) {
    var minX = Math.min(a[0], b[0]);
    var minY = Math.min(a[1], b[1]);
    var maxX = Math.max(a[0], b[0]);
    var maxY = Math.max(a[1], b[1]);

    var edges = segTree.search({minX: minX, minY: minY, maxX: maxX, maxY: maxY});
    for (var i = 0; i < edges.length; i++) {
        if (intersects(edges[i].p, edges[i].next.p, a, b)) return false;
    }
    return true;
}

// check if the edges (p1,q1) and (p2,q2) intersect
function intersects(p1, q1, p2, q2) {
    return p1 !== q2 && q1 !== p2 &&
        orient(p1, q1, p2) > 0 !== orient(p1, q1, q2) > 0 &&
        orient(p2, q2, p1) > 0 !== orient(p2, q2, q1) > 0;
}

// update the bounding box of a node's edge
function updateBBox(node) {
    var p1 = node.p;
    var p2 = node.next.p;
    node.minX = Math.min(p1[0], p2[0]);
    node.minY = Math.min(p1[1], p2[1]);
    node.maxX = Math.max(p1[0], p2[0]);
    node.maxY = Math.max(p1[1], p2[1]);
    return node;
}

// speed up convex hull by filtering out points inside quadrilateral formed by 4 extreme points
function fastConvexHull(points) {
    var left = points[0];
    var top = points[0];
    var right = points[0];
    var bottom = points[0];

    // find the leftmost, rightmost, topmost and bottommost points
    for (var i = 0; i < points.length; i++) {
        var p = points[i];
        if (p[0] < left[0]) left = p;
        if (p[0] > right[0]) right = p;
        if (p[1] < top[1]) top = p;
        if (p[1] > bottom[1]) bottom = p;
    }

    // filter out points that are inside the resulting quadrilateral
    var cull = [left, top, right, bottom];
    var filtered = cull.slice();
    for (i = 0; i < points.length; i++) {
        if (!pointInPolygon(points[i], cull)) filtered.push(points[i]);
    }

    // get convex hull around the filtered points
    var indices = convexHull(filtered);

    // return the hull as array of points (rather than indices)
    var hull = [];
    for (i = 0; i < indices.length; i++) hull.push(filtered[indices[i]]);
    return hull;
}

// create a new node in a doubly linked list
function insertNode(p, prev) {
    var node = {
        p: p,
        prev: null,
        next: null,
        minX: 0,
        minY: 0,
        maxX: 0,
        maxY: 0
    };

    if (!prev) {
        node.prev = node;
        node.next = node;

    } else {
        node.next = prev.next;
        node.prev = prev;
        prev.next.prev = node;
        prev.next = node;
    }
    return node;
}

// square distance between 2 points
function getSqDist(p1, p2) {

    var dx = p1[0] - p2[0],
        dy = p1[1] - p2[1];

    return dx * dx + dy * dy;
}

// square distance from a point to a segment
function sqSegDist(p, p1, p2) {

    var x = p1[0],
        y = p1[1],
        dx = p2[0] - x,
        dy = p2[1] - y;

    if (dx !== 0 || dy !== 0) {

        var t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);

        if (t > 1) {
            x = p2[0];
            y = p2[1];

        } else if (t > 0) {
            x += dx * t;
            y += dy * t;
        }
    }

    dx = p[0] - x;
    dy = p[1] - y;

    return dx * dx + dy * dy;
}

// segment to segment distance, ported from http://geomalgorithms.com/a07-_distance.html by Dan Sunday
function sqSegSegDist(x0, y0, x1, y1, x2, y2, x3, y3) {
    var ux = x1 - x0;
    var uy = y1 - y0;
    var vx = x3 - x2;
    var vy = y3 - y2;
    var wx = x0 - x2;
    var wy = y0 - y2;
    var a = ux * ux + uy * uy;
    var b = ux * vx + uy * vy;
    var c = vx * vx + vy * vy;
    var d = ux * wx + uy * wy;
    var e = vx * wx + vy * wy;
    var D = a * c - b * b;

    var sc, sN, tc, tN;
    var sD = D;
    var tD = D;

    if (D === 0) {
        sN = 0;
        sD = 1;
        tN = e;
        tD = c;
    } else {
        sN = b * e - c * d;
        tN = a * e - b * d;
        if (sN < 0) {
            sN = 0;
            tN = e;
            tD = c;
        } else if (sN > sD) {
            sN = sD;
            tN = e + b;
            tD = c;
        }
    }

    if (tN < 0.0) {
        tN = 0.0;
        if (-d < 0.0) sN = 0.0;
        else if (-d > a) sN = sD;
        else {
            sN = -d;
            sD = a;
        }
    } else if (tN > tD) {
        tN = tD;
        if ((-d + b) < 0.0) sN = 0;
        else if (-d + b > a) sN = sD;
        else {
            sN = -d + b;
            sD = a;
        }
    }

    sc = sN === 0 ? 0 : sN / sD;
    tc = tN === 0 ? 0 : tN / tD;

    var cx = (1 - sc) * x0 + sc * x1;
    var cy = (1 - sc) * y0 + sc * y1;
    var cx2 = (1 - tc) * x2 + tc * x3;
    var cy2 = (1 - tc) * y2 + tc * y3;
    var dx = cx2 - cx;
    var dy = cy2 - cy;

    return dx * dx + dy * dy;
}

},{"monotone-convex-hull-2d":3,"point-in-polygon":4,"rbush":6,"robust-orientation":7,"tinyqueue":12}],2:[function(require,module,exports){
(function (global){
/**
 * @license
 * Lodash <https://lodash.com/>
 * Copyright JS Foundation and other contributors <https://js.foundation/>
 * Released under MIT license <https://lodash.com/license>
 * Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
 * Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
 */
;(function() {

  /** Used as a safe reference for `undefined` in pre-ES5 environments. */
  var undefined;

  /** Used as the semantic version number. */
  var VERSION = '4.17.4';

  /** Used as the size to enable large array optimizations. */
  var LARGE_ARRAY_SIZE = 200;

  /** Error message constants. */
  var CORE_ERROR_TEXT = 'Unsupported core-js use. Try https://npms.io/search?q=ponyfill.',
      FUNC_ERROR_TEXT = 'Expected a function';

  /** Used to stand-in for `undefined` hash values. */
  var HASH_UNDEFINED = '__lodash_hash_undefined__';

  /** Used as the maximum memoize cache size. */
  var MAX_MEMOIZE_SIZE = 500;

  /** Used as the internal argument placeholder. */
  var PLACEHOLDER = '__lodash_placeholder__';

  /** Used to compose bitmasks for cloning. */
  var CLONE_DEEP_FLAG = 1,
      CLONE_FLAT_FLAG = 2,
      CLONE_SYMBOLS_FLAG = 4;

  /** Used to compose bitmasks for value comparisons. */
  var COMPARE_PARTIAL_FLAG = 1,
      COMPARE_UNORDERED_FLAG = 2;

  /** Used to compose bitmasks for function metadata. */
  var WRAP_BIND_FLAG = 1,
      WRAP_BIND_KEY_FLAG = 2,
      WRAP_CURRY_BOUND_FLAG = 4,
      WRAP_CURRY_FLAG = 8,
      WRAP_CURRY_RIGHT_FLAG = 16,
      WRAP_PARTIAL_FLAG = 32,
      WRAP_PARTIAL_RIGHT_FLAG = 64,
      WRAP_ARY_FLAG = 128,
      WRAP_REARG_FLAG = 256,
      WRAP_FLIP_FLAG = 512;

  /** Used as default options for `_.truncate`. */
  var DEFAULT_TRUNC_LENGTH = 30,
      DEFAULT_TRUNC_OMISSION = '...';

  /** Used to detect hot functions by number of calls within a span of milliseconds. */
  var HOT_COUNT = 800,
      HOT_SPAN = 16;

  /** Used to indicate the type of lazy iteratees. */
  var LAZY_FILTER_FLAG = 1,
      LAZY_MAP_FLAG = 2,
      LAZY_WHILE_FLAG = 3;

  /** Used as references for various `Number` constants. */
  var INFINITY = 1 / 0,
      MAX_SAFE_INTEGER = 9007199254740991,
      MAX_INTEGER = 1.7976931348623157e+308,
      NAN = 0 / 0;

  /** Used as references for the maximum length and index of an array. */
  var MAX_ARRAY_LENGTH = 4294967295,
      MAX_ARRAY_INDEX = MAX_ARRAY_LENGTH - 1,
      HALF_MAX_ARRAY_LENGTH = MAX_ARRAY_LENGTH >>> 1;

  /** Used to associate wrap methods with their bit flags. */
  var wrapFlags = [
    ['ary', WRAP_ARY_FLAG],
    ['bind', WRAP_BIND_FLAG],
    ['bindKey', WRAP_BIND_KEY_FLAG],
    ['curry', WRAP_CURRY_FLAG],
    ['curryRight', WRAP_CURRY_RIGHT_FLAG],
    ['flip', WRAP_FLIP_FLAG],
    ['partial', WRAP_PARTIAL_FLAG],
    ['partialRight', WRAP_PARTIAL_RIGHT_FLAG],
    ['rearg', WRAP_REARG_FLAG]
  ];

  /** `Object#toString` result references. */
  var argsTag = '[object Arguments]',
      arrayTag = '[object Array]',
      asyncTag = '[object AsyncFunction]',
      boolTag = '[object Boolean]',
      dateTag = '[object Date]',
      domExcTag = '[object DOMException]',
      errorTag = '[object Error]',
      funcTag = '[object Function]',
      genTag = '[object GeneratorFunction]',
      mapTag = '[object Map]',
      numberTag = '[object Number]',
      nullTag = '[object Null]',
      objectTag = '[object Object]',
      promiseTag = '[object Promise]',
      proxyTag = '[object Proxy]',
      regexpTag = '[object RegExp]',
      setTag = '[object Set]',
      stringTag = '[object String]',
      symbolTag = '[object Symbol]',
      undefinedTag = '[object Undefined]',
      weakMapTag = '[object WeakMap]',
      weakSetTag = '[object WeakSet]';

  var arrayBufferTag = '[object ArrayBuffer]',
      dataViewTag = '[object DataView]',
      float32Tag = '[object Float32Array]',
      float64Tag = '[object Float64Array]',
      int8Tag = '[object Int8Array]',
      int16Tag = '[object Int16Array]',
      int32Tag = '[object Int32Array]',
      uint8Tag = '[object Uint8Array]',
      uint8ClampedTag = '[object Uint8ClampedArray]',
      uint16Tag = '[object Uint16Array]',
      uint32Tag = '[object Uint32Array]';

  /** Used to match empty string literals in compiled template source. */
  var reEmptyStringLeading = /\b__p \+= '';/g,
      reEmptyStringMiddle = /\b(__p \+=) '' \+/g,
      reEmptyStringTrailing = /(__e\(.*?\)|\b__t\)) \+\n'';/g;

  /** Used to match HTML entities and HTML characters. */
  var reEscapedHtml = /&(?:amp|lt|gt|quot|#39);/g,
      reUnescapedHtml = /[&<>"']/g,
      reHasEscapedHtml = RegExp(reEscapedHtml.source),
      reHasUnescapedHtml = RegExp(reUnescapedHtml.source);

  /** Used to match template delimiters. */
  var reEscape = /<%-([\s\S]+?)%>/g,
      reEvaluate = /<%([\s\S]+?)%>/g,
      reInterpolate = /<%=([\s\S]+?)%>/g;

  /** Used to match property names within property paths. */
  var reIsDeepProp = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\\]|\\.)*?\1)\]/,
      reIsPlainProp = /^\w*$/,
      reLeadingDot = /^\./,
      rePropName = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g;

  /**
   * Used to match `RegExp`
   * [syntax characters](http://ecma-international.org/ecma-262/7.0/#sec-patterns).
   */
  var reRegExpChar = /[\\^$.*+?()[\]{}|]/g,
      reHasRegExpChar = RegExp(reRegExpChar.source);

  /** Used to match leading and trailing whitespace. */
  var reTrim = /^\s+|\s+$/g,
      reTrimStart = /^\s+/,
      reTrimEnd = /\s+$/;

  /** Used to match wrap detail comments. */
  var reWrapComment = /\{(?:\n\/\* \[wrapped with .+\] \*\/)?\n?/,
      reWrapDetails = /\{\n\/\* \[wrapped with (.+)\] \*/,
      reSplitDetails = /,? & /;

  /** Used to match words composed of alphanumeric characters. */
  var reAsciiWord = /[^\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g;

  /** Used to match backslashes in property paths. */
  var reEscapeChar = /\\(\\)?/g;

  /**
   * Used to match
   * [ES template delimiters](http://ecma-international.org/ecma-262/7.0/#sec-template-literal-lexical-components).
   */
  var reEsTemplate = /\$\{([^\\}]*(?:\\.[^\\}]*)*)\}/g;

  /** Used to match `RegExp` flags from their coerced string values. */
  var reFlags = /\w*$/;

  /** Used to detect bad signed hexadecimal string values. */
  var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;

  /** Used to detect binary string values. */
  var reIsBinary = /^0b[01]+$/i;

  /** Used to detect host constructors (Safari). */
  var reIsHostCtor = /^\[object .+?Constructor\]$/;

  /** Used to detect octal string values. */
  var reIsOctal = /^0o[0-7]+$/i;

  /** Used to detect unsigned integer values. */
  var reIsUint = /^(?:0|[1-9]\d*)$/;

  /** Used to match Latin Unicode letters (excluding mathematical operators). */
  var reLatin = /[\xc0-\xd6\xd8-\xf6\xf8-\xff\u0100-\u017f]/g;

  /** Used to ensure capturing order of template delimiters. */
  var reNoMatch = /($^)/;

  /** Used to match unescaped characters in compiled string literals. */
  var reUnescapedString = /['\n\r\u2028\u2029\\]/g;

  /** Used to compose unicode character classes. */
  var rsAstralRange = '\\ud800-\\udfff',
      rsComboMarksRange = '\\u0300-\\u036f',
      reComboHalfMarksRange = '\\ufe20-\\ufe2f',
      rsComboSymbolsRange = '\\u20d0-\\u20ff',
      rsComboRange = rsComboMarksRange + reComboHalfMarksRange + rsComboSymbolsRange,
      rsDingbatRange = '\\u2700-\\u27bf',
      rsLowerRange = 'a-z\\xdf-\\xf6\\xf8-\\xff',
      rsMathOpRange = '\\xac\\xb1\\xd7\\xf7',
      rsNonCharRange = '\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf',
      rsPunctuationRange = '\\u2000-\\u206f',
      rsSpaceRange = ' \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000',
      rsUpperRange = 'A-Z\\xc0-\\xd6\\xd8-\\xde',
      rsVarRange = '\\ufe0e\\ufe0f',
      rsBreakRange = rsMathOpRange + rsNonCharRange + rsPunctuationRange + rsSpaceRange;

  /** Used to compose unicode capture groups. */
  var rsApos = "['\u2019]",
      rsAstral = '[' + rsAstralRange + ']',
      rsBreak = '[' + rsBreakRange + ']',
      rsCombo = '[' + rsComboRange + ']',
      rsDigits = '\\d+',
      rsDingbat = '[' + rsDingbatRange + ']',
      rsLower = '[' + rsLowerRange + ']',
      rsMisc = '[^' + rsAstralRange + rsBreakRange + rsDigits + rsDingbatRange + rsLowerRange + rsUpperRange + ']',
      rsFitz = '\\ud83c[\\udffb-\\udfff]',
      rsModifier = '(?:' + rsCombo + '|' + rsFitz + ')',
      rsNonAstral = '[^' + rsAstralRange + ']',
      rsRegional = '(?:\\ud83c[\\udde6-\\uddff]){2}',
      rsSurrPair = '[\\ud800-\\udbff][\\udc00-\\udfff]',
      rsUpper = '[' + rsUpperRange + ']',
      rsZWJ = '\\u200d';

  /** Used to compose unicode regexes. */
  var rsMiscLower = '(?:' + rsLower + '|' + rsMisc + ')',
      rsMiscUpper = '(?:' + rsUpper + '|' + rsMisc + ')',
      rsOptContrLower = '(?:' + rsApos + '(?:d|ll|m|re|s|t|ve))?',
      rsOptContrUpper = '(?:' + rsApos + '(?:D|LL|M|RE|S|T|VE))?',
      reOptMod = rsModifier + '?',
      rsOptVar = '[' + rsVarRange + ']?',
      rsOptJoin = '(?:' + rsZWJ + '(?:' + [rsNonAstral, rsRegional, rsSurrPair].join('|') + ')' + rsOptVar + reOptMod + ')*',
      rsOrdLower = '\\d*(?:(?:1st|2nd|3rd|(?![123])\\dth)\\b)',
      rsOrdUpper = '\\d*(?:(?:1ST|2ND|3RD|(?![123])\\dTH)\\b)',
      rsSeq = rsOptVar + reOptMod + rsOptJoin,
      rsEmoji = '(?:' + [rsDingbat, rsRegional, rsSurrPair].join('|') + ')' + rsSeq,
      rsSymbol = '(?:' + [rsNonAstral + rsCombo + '?', rsCombo, rsRegional, rsSurrPair, rsAstral].join('|') + ')';

  /** Used to match apostrophes. */
  var reApos = RegExp(rsApos, 'g');

  /**
   * Used to match [combining diacritical marks](https://en.wikipedia.org/wiki/Combining_Diacritical_Marks) and
   * [combining diacritical marks for symbols](https://en.wikipedia.org/wiki/Combining_Diacritical_Marks_for_Symbols).
   */
  var reComboMark = RegExp(rsCombo, 'g');

  /** Used to match [string symbols](https://mathiasbynens.be/notes/javascript-unicode). */
  var reUnicode = RegExp(rsFitz + '(?=' + rsFitz + ')|' + rsSymbol + rsSeq, 'g');

  /** Used to match complex or compound words. */
  var reUnicodeWord = RegExp([
    rsUpper + '?' + rsLower + '+' + rsOptContrLower + '(?=' + [rsBreak, rsUpper, '$'].join('|') + ')',
    rsMiscUpper + '+' + rsOptContrUpper + '(?=' + [rsBreak, rsUpper + rsMiscLower, '$'].join('|') + ')',
    rsUpper + '?' + rsMiscLower + '+' + rsOptContrLower,
    rsUpper + '+' + rsOptContrUpper,
    rsOrdUpper,
    rsOrdLower,
    rsDigits,
    rsEmoji
  ].join('|'), 'g');

  /** Used to detect strings with [zero-width joiners or code points from the astral planes](http://eev.ee/blog/2015/09/12/dark-corners-of-unicode/). */
  var reHasUnicode = RegExp('[' + rsZWJ + rsAstralRange  + rsComboRange + rsVarRange + ']');

  /** Used to detect strings that need a more robust regexp to match words. */
  var reHasUnicodeWord = /[a-z][A-Z]|[A-Z]{2,}[a-z]|[0-9][a-zA-Z]|[a-zA-Z][0-9]|[^a-zA-Z0-9 ]/;

  /** Used to assign default `context` object properties. */
  var contextProps = [
    'Array', 'Buffer', 'DataView', 'Date', 'Error', 'Float32Array', 'Float64Array',
    'Function', 'Int8Array', 'Int16Array', 'Int32Array', 'Map', 'Math', 'Object',
    'Promise', 'RegExp', 'Set', 'String', 'Symbol', 'TypeError', 'Uint8Array',
    'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'WeakMap',
    '_', 'clearTimeout', 'isFinite', 'parseInt', 'setTimeout'
  ];

  /** Used to make template sourceURLs easier to identify. */
  var templateCounter = -1;

  /** Used to identify `toStringTag` values of typed arrays. */
  var typedArrayTags = {};
  typedArrayTags[float32Tag] = typedArrayTags[float64Tag] =
  typedArrayTags[int8Tag] = typedArrayTags[int16Tag] =
  typedArrayTags[int32Tag] = typedArrayTags[uint8Tag] =
  typedArrayTags[uint8ClampedTag] = typedArrayTags[uint16Tag] =
  typedArrayTags[uint32Tag] = true;
  typedArrayTags[argsTag] = typedArrayTags[arrayTag] =
  typedArrayTags[arrayBufferTag] = typedArrayTags[boolTag] =
  typedArrayTags[dataViewTag] = typedArrayTags[dateTag] =
  typedArrayTags[errorTag] = typedArrayTags[funcTag] =
  typedArrayTags[mapTag] = typedArrayTags[numberTag] =
  typedArrayTags[objectTag] = typedArrayTags[regexpTag] =
  typedArrayTags[setTag] = typedArrayTags[stringTag] =
  typedArrayTags[weakMapTag] = false;

  /** Used to identify `toStringTag` values supported by `_.clone`. */
  var cloneableTags = {};
  cloneableTags[argsTag] = cloneableTags[arrayTag] =
  cloneableTags[arrayBufferTag] = cloneableTags[dataViewTag] =
  cloneableTags[boolTag] = cloneableTags[dateTag] =
  cloneableTags[float32Tag] = cloneableTags[float64Tag] =
  cloneableTags[int8Tag] = cloneableTags[int16Tag] =
  cloneableTags[int32Tag] = cloneableTags[mapTag] =
  cloneableTags[numberTag] = cloneableTags[objectTag] =
  cloneableTags[regexpTag] = cloneableTags[setTag] =
  cloneableTags[stringTag] = cloneableTags[symbolTag] =
  cloneableTags[uint8Tag] = cloneableTags[uint8ClampedTag] =
  cloneableTags[uint16Tag] = cloneableTags[uint32Tag] = true;
  cloneableTags[errorTag] = cloneableTags[funcTag] =
  cloneableTags[weakMapTag] = false;

  /** Used to map Latin Unicode letters to basic Latin letters. */
  var deburredLetters = {
    // Latin-1 Supplement block.
    '\xc0': 'A',  '\xc1': 'A', '\xc2': 'A', '\xc3': 'A', '\xc4': 'A', '\xc5': 'A',
    '\xe0': 'a',  '\xe1': 'a', '\xe2': 'a', '\xe3': 'a', '\xe4': 'a', '\xe5': 'a',
    '\xc7': 'C',  '\xe7': 'c',
    '\xd0': 'D',  '\xf0': 'd',
    '\xc8': 'E',  '\xc9': 'E', '\xca': 'E', '\xcb': 'E',
    '\xe8': 'e',  '\xe9': 'e', '\xea': 'e', '\xeb': 'e',
    '\xcc': 'I',  '\xcd': 'I', '\xce': 'I', '\xcf': 'I',
    '\xec': 'i',  '\xed': 'i', '\xee': 'i', '\xef': 'i',
    '\xd1': 'N',  '\xf1': 'n',
    '\xd2': 'O',  '\xd3': 'O', '\xd4': 'O', '\xd5': 'O', '\xd6': 'O', '\xd8': 'O',
    '\xf2': 'o',  '\xf3': 'o', '\xf4': 'o', '\xf5': 'o', '\xf6': 'o', '\xf8': 'o',
    '\xd9': 'U',  '\xda': 'U', '\xdb': 'U', '\xdc': 'U',
    '\xf9': 'u',  '\xfa': 'u', '\xfb': 'u', '\xfc': 'u',
    '\xdd': 'Y',  '\xfd': 'y', '\xff': 'y',
    '\xc6': 'Ae', '\xe6': 'ae',
    '\xde': 'Th', '\xfe': 'th',
    '\xdf': 'ss',
    // Latin Extended-A block.
    '\u0100': 'A',  '\u0102': 'A', '\u0104': 'A',
    '\u0101': 'a',  '\u0103': 'a', '\u0105': 'a',
    '\u0106': 'C',  '\u0108': 'C', '\u010a': 'C', '\u010c': 'C',
    '\u0107': 'c',  '\u0109': 'c', '\u010b': 'c', '\u010d': 'c',
    '\u010e': 'D',  '\u0110': 'D', '\u010f': 'd', '\u0111': 'd',
    '\u0112': 'E',  '\u0114': 'E', '\u0116': 'E', '\u0118': 'E', '\u011a': 'E',
    '\u0113': 'e',  '\u0115': 'e', '\u0117': 'e', '\u0119': 'e', '\u011b': 'e',
    '\u011c': 'G',  '\u011e': 'G', '\u0120': 'G', '\u0122': 'G',
    '\u011d': 'g',  '\u011f': 'g', '\u0121': 'g', '\u0123': 'g',
    '\u0124': 'H',  '\u0126': 'H', '\u0125': 'h', '\u0127': 'h',
    '\u0128': 'I',  '\u012a': 'I', '\u012c': 'I', '\u012e': 'I', '\u0130': 'I',
    '\u0129': 'i',  '\u012b': 'i', '\u012d': 'i', '\u012f': 'i', '\u0131': 'i',
    '\u0134': 'J',  '\u0135': 'j',
    '\u0136': 'K',  '\u0137': 'k', '\u0138': 'k',
    '\u0139': 'L',  '\u013b': 'L', '\u013d': 'L', '\u013f': 'L', '\u0141': 'L',
    '\u013a': 'l',  '\u013c': 'l', '\u013e': 'l', '\u0140': 'l', '\u0142': 'l',
    '\u0143': 'N',  '\u0145': 'N', '\u0147': 'N', '\u014a': 'N',
    '\u0144': 'n',  '\u0146': 'n', '\u0148': 'n', '\u014b': 'n',
    '\u014c': 'O',  '\u014e': 'O', '\u0150': 'O',
    '\u014d': 'o',  '\u014f': 'o', '\u0151': 'o',
    '\u0154': 'R',  '\u0156': 'R', '\u0158': 'R',
    '\u0155': 'r',  '\u0157': 'r', '\u0159': 'r',
    '\u015a': 'S',  '\u015c': 'S', '\u015e': 'S', '\u0160': 'S',
    '\u015b': 's',  '\u015d': 's', '\u015f': 's', '\u0161': 's',
    '\u0162': 'T',  '\u0164': 'T', '\u0166': 'T',
    '\u0163': 't',  '\u0165': 't', '\u0167': 't',
    '\u0168': 'U',  '\u016a': 'U', '\u016c': 'U', '\u016e': 'U', '\u0170': 'U', '\u0172': 'U',
    '\u0169': 'u',  '\u016b': 'u', '\u016d': 'u', '\u016f': 'u', '\u0171': 'u', '\u0173': 'u',
    '\u0174': 'W',  '\u0175': 'w',
    '\u0176': 'Y',  '\u0177': 'y', '\u0178': 'Y',
    '\u0179': 'Z',  '\u017b': 'Z', '\u017d': 'Z',
    '\u017a': 'z',  '\u017c': 'z', '\u017e': 'z',
    '\u0132': 'IJ', '\u0133': 'ij',
    '\u0152': 'Oe', '\u0153': 'oe',
    '\u0149': "'n", '\u017f': 's'
  };

  /** Used to map characters to HTML entities. */
  var htmlEscapes = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  /** Used to map HTML entities to characters. */
  var htmlUnescapes = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'"
  };

  /** Used to escape characters for inclusion in compiled string literals. */
  var stringEscapes = {
    '\\': '\\',
    "'": "'",
    '\n': 'n',
    '\r': 'r',
    '\u2028': 'u2028',
    '\u2029': 'u2029'
  };

  /** Built-in method references without a dependency on `root`. */
  var freeParseFloat = parseFloat,
      freeParseInt = parseInt;

  /** Detect free variable `global` from Node.js. */
  var freeGlobal = typeof global == 'object' && global && global.Object === Object && global;

  /** Detect free variable `self`. */
  var freeSelf = typeof self == 'object' && self && self.Object === Object && self;

  /** Used as a reference to the global object. */
  var root = freeGlobal || freeSelf || Function('return this')();

  /** Detect free variable `exports`. */
  var freeExports = typeof exports == 'object' && exports && !exports.nodeType && exports;

  /** Detect free variable `module`. */
  var freeModule = freeExports && typeof module == 'object' && module && !module.nodeType && module;

  /** Detect the popular CommonJS extension `module.exports`. */
  var moduleExports = freeModule && freeModule.exports === freeExports;

  /** Detect free variable `process` from Node.js. */
  var freeProcess = moduleExports && freeGlobal.process;

  /** Used to access faster Node.js helpers. */
  var nodeUtil = (function() {
    try {
      return freeProcess && freeProcess.binding && freeProcess.binding('util');
    } catch (e) {}
  }());

  /* Node.js helper references. */
  var nodeIsArrayBuffer = nodeUtil && nodeUtil.isArrayBuffer,
      nodeIsDate = nodeUtil && nodeUtil.isDate,
      nodeIsMap = nodeUtil && nodeUtil.isMap,
      nodeIsRegExp = nodeUtil && nodeUtil.isRegExp,
      nodeIsSet = nodeUtil && nodeUtil.isSet,
      nodeIsTypedArray = nodeUtil && nodeUtil.isTypedArray;

  /*--------------------------------------------------------------------------*/

  /**
   * Adds the key-value `pair` to `map`.
   *
   * @private
   * @param {Object} map The map to modify.
   * @param {Array} pair The key-value pair to add.
   * @returns {Object} Returns `map`.
   */
  function addMapEntry(map, pair) {
    // Don't return `map.set` because it's not chainable in IE 11.
    map.set(pair[0], pair[1]);
    return map;
  }

  /**
   * Adds `value` to `set`.
   *
   * @private
   * @param {Object} set The set to modify.
   * @param {*} value The value to add.
   * @returns {Object} Returns `set`.
   */
  function addSetEntry(set, value) {
    // Don't return `set.add` because it's not chainable in IE 11.
    set.add(value);
    return set;
  }

  /**
   * A faster alternative to `Function#apply`, this function invokes `func`
   * with the `this` binding of `thisArg` and the arguments of `args`.
   *
   * @private
   * @param {Function} func The function to invoke.
   * @param {*} thisArg The `this` binding of `func`.
   * @param {Array} args The arguments to invoke `func` with.
   * @returns {*} Returns the result of `func`.
   */
  function apply(func, thisArg, args) {
    switch (args.length) {
      case 0: return func.call(thisArg);
      case 1: return func.call(thisArg, args[0]);
      case 2: return func.call(thisArg, args[0], args[1]);
      case 3: return func.call(thisArg, args[0], args[1], args[2]);
    }
    return func.apply(thisArg, args);
  }

  /**
   * A specialized version of `baseAggregator` for arrays.
   *
   * @private
   * @param {Array} [array] The array to iterate over.
   * @param {Function} setter The function to set `accumulator` values.
   * @param {Function} iteratee The iteratee to transform keys.
   * @param {Object} accumulator The initial aggregated object.
   * @returns {Function} Returns `accumulator`.
   */
  function arrayAggregator(array, setter, iteratee, accumulator) {
    var index = -1,
        length = array == null ? 0 : array.length;

    while (++index < length) {
      var value = array[index];
      setter(accumulator, value, iteratee(value), array);
    }
    return accumulator;
  }

  /**
   * A specialized version of `_.forEach` for arrays without support for
   * iteratee shorthands.
   *
   * @private
   * @param {Array} [array] The array to iterate over.
   * @param {Function} iteratee The function invoked per iteration.
   * @returns {Array} Returns `array`.
   */
  function arrayEach(array, iteratee) {
    var index = -1,
        length = array == null ? 0 : array.length;

    while (++index < length) {
      if (iteratee(array[index], index, array) === false) {
        break;
      }
    }
    return array;
  }

  /**
   * A specialized version of `_.forEachRight` for arrays without support for
   * iteratee shorthands.
   *
   * @private
   * @param {Array} [array] The array to iterate over.
   * @param {Function} iteratee The function invoked per iteration.
   * @returns {Array} Returns `array`.
   */
  function arrayEachRight(array, iteratee) {
    var length = array == null ? 0 : array.length;

    while (length--) {
      if (iteratee(array[length], length, array) === false) {
        break;
      }
    }
    return array;
  }

  /**
   * A specialized version of `_.every` for arrays without support for
   * iteratee shorthands.
   *
   * @private
   * @param {Array} [array] The array to iterate over.
   * @param {Function} predicate The function invoked per iteration.
   * @returns {boolean} Returns `true` if all elements pass the predicate check,
   *  else `false`.
   */
  function arrayEvery(array, predicate) {
    var index = -1,
        length = array == null ? 0 : array.length;

    while (++index < length) {
      if (!predicate(array[index], index, array)) {
        return false;
      }
    }
    return true;
  }

  /**
   * A specialized version of `_.filter` for arrays without support for
   * iteratee shorthands.
   *
   * @private
   * @param {Array} [array] The array to iterate over.
   * @param {Function} predicate The function invoked per iteration.
   * @returns {Array} Returns the new filtered array.
   */
  function arrayFilter(array, predicate) {
    var index = -1,
        length = array == null ? 0 : array.length,
        resIndex = 0,
        result = [];

    while (++index < length) {
      var value = array[index];
      if (predicate(value, index, array)) {
        result[resIndex++] = value;
      }
    }
    return result;
  }

  /**
   * A specialized version of `_.includes` for arrays without support for
   * specifying an index to search from.
   *
   * @private
   * @param {Array} [array] The array to inspect.
   * @param {*} target The value to search for.
   * @returns {boolean} Returns `true` if `target` is found, else `false`.
   */
  function arrayIncludes(array, value) {
    var length = array == null ? 0 : array.length;
    return !!length && baseIndexOf(array, value, 0) > -1;
  }

  /**
   * This function is like `arrayIncludes` except that it accepts a comparator.
   *
   * @private
   * @param {Array} [array] The array to inspect.
   * @param {*} target The value to search for.
   * @param {Function} comparator The comparator invoked per element.
   * @returns {boolean} Returns `true` if `target` is found, else `false`.
   */
  function arrayIncludesWith(array, value, comparator) {
    var index = -1,
        length = array == null ? 0 : array.length;

    while (++index < length) {
      if (comparator(value, array[index])) {
        return true;
      }
    }
    return false;
  }

  /**
   * A specialized version of `_.map` for arrays without support for iteratee
   * shorthands.
   *
   * @private
   * @param {Array} [array] The array to iterate over.
   * @param {Function} iteratee The function invoked per iteration.
   * @returns {Array} Returns the new mapped array.
   */
  function arrayMap(array, iteratee) {
    var index = -1,
        length = array == null ? 0 : array.length,
        result = Array(length);

    while (++index < length) {
      result[index] = iteratee(array[index], index, array);
    }
    return result;
  }

  /**
   * Appends the elements of `values` to `array`.
   *
   * @private
   * @param {Array} array The array to modify.
   * @param {Array} values The values to append.
   * @returns {Array} Returns `array`.
   */
  function arrayPush(array, values) {
    var index = -1,
        length = values.length,
        offset = array.length;

    while (++index < length) {
      array[offset + index] = values[index];
    }
    return array;
  }

  /**
   * A specialized version of `_.reduce` for arrays without support for
   * iteratee shorthands.
   *
   * @private
   * @param {Array} [array] The array to iterate over.
   * @param {Function} iteratee The function invoked per iteration.
   * @param {*} [accumulator] The initial value.
   * @param {boolean} [initAccum] Specify using the first element of `array` as
   *  the initial value.
   * @returns {*} Returns the accumulated value.
   */
  function arrayReduce(array, iteratee, accumulator, initAccum) {
    var index = -1,
        length = array == null ? 0 : array.length;

    if (initAccum && length) {
      accumulator = array[++index];
    }
    while (++index < length) {
      accumulator = iteratee(accumulator, array[index], index, array);
    }
    return accumulator;
  }

  /**
   * A specialized version of `_.reduceRight` for arrays without support for
   * iteratee shorthands.
   *
   * @private
   * @param {Array} [array] The array to iterate over.
   * @param {Function} iteratee The function invoked per iteration.
   * @param {*} [accumulator] The initial value.
   * @param {boolean} [initAccum] Specify using the last element of `array` as
   *  the initial value.
   * @returns {*} Returns the accumulated value.
   */
  function arrayReduceRight(array, iteratee, accumulator, initAccum) {
    var length = array == null ? 0 : array.length;
    if (initAccum && length) {
      accumulator = array[--length];
    }
    while (length--) {
      accumulator = iteratee(accumulator, array[length], length, array);
    }
    return accumulator;
  }

  /**
   * A specialized version of `_.some` for arrays without support for iteratee
   * shorthands.
   *
   * @private
   * @param {Array} [array] The array to iterate over.
   * @param {Function} predicate The function invoked per iteration.
   * @returns {boolean} Returns `true` if any element passes the predicate check,
   *  else `false`.
   */
  function arraySome(array, predicate) {
    var index = -1,
        length = array == null ? 0 : array.length;

    while (++index < length) {
      if (predicate(array[index], index, array)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Gets the size of an ASCII `string`.
   *
   * @private
   * @param {string} string The string inspect.
   * @returns {number} Returns the string size.
   */
  var asciiSize = baseProperty('length');

  /**
   * Converts an ASCII `string` to an array.
   *
   * @private
   * @param {string} string The string to convert.
   * @returns {Array} Returns the converted array.
   */
  function asciiToArray(string) {
    return string.split('');
  }

  /**
   * Splits an ASCII `string` into an array of its words.
   *
   * @private
   * @param {string} The string to inspect.
   * @returns {Array} Returns the words of `string`.
   */
  function asciiWords(string) {
    return string.match(reAsciiWord) || [];
  }

  /**
   * The base implementation of methods like `_.findKey` and `_.findLastKey`,
   * without support for iteratee shorthands, which iterates over `collection`
   * using `eachFunc`.
   *
   * @private
   * @param {Array|Object} collection The collection to inspect.
   * @param {Function} predicate The function invoked per iteration.
   * @param {Function} eachFunc The function to iterate over `collection`.
   * @returns {*} Returns the found element or its key, else `undefined`.
   */
  function baseFindKey(collection, predicate, eachFunc) {
    var result;
    eachFunc(collection, function(value, key, collection) {
      if (predicate(value, key, collection)) {
        result = key;
        return false;
      }
    });
    return result;
  }

  /**
   * The base implementation of `_.findIndex` and `_.findLastIndex` without
   * support for iteratee shorthands.
   *
   * @private
   * @param {Array} array The array to inspect.
   * @param {Function} predicate The function invoked per iteration.
   * @param {number} fromIndex The index to search from.
   * @param {boolean} [fromRight] Specify iterating from right to left.
   * @returns {number} Returns the index of the matched value, else `-1`.
   */
  function baseFindIndex(array, predicate, fromIndex, fromRight) {
    var length = array.length,
        index = fromIndex + (fromRight ? 1 : -1);

    while ((fromRight ? index-- : ++index < length)) {
      if (predicate(array[index], index, array)) {
        return index;
      }
    }
    return -1;
  }

  /**
   * The base implementation of `_.indexOf` without `fromIndex` bounds checks.
   *
   * @private
   * @param {Array} array The array to inspect.
   * @param {*} value The value to search for.
   * @param {number} fromIndex The index to search from.
   * @returns {number} Returns the index of the matched value, else `-1`.
   */
  function baseIndexOf(array, value, fromIndex) {
    return value === value
      ? strictIndexOf(array, value, fromIndex)
      : baseFindIndex(array, baseIsNaN, fromIndex);
  }

  /**
   * This function is like `baseIndexOf` except that it accepts a comparator.
   *
   * @private
   * @param {Array} array The array to inspect.
   * @param {*} value The value to search for.
   * @param {number} fromIndex The index to search from.
   * @param {Function} comparator The comparator invoked per element.
   * @returns {number} Returns the index of the matched value, else `-1`.
   */
  function baseIndexOfWith(array, value, fromIndex, comparator) {
    var index = fromIndex - 1,
        length = array.length;

    while (++index < length) {
      if (comparator(array[index], value)) {
        return index;
      }
    }
    return -1;
  }

  /**
   * The base implementation of `_.isNaN` without support for number objects.
   *
   * @private
   * @param {*} value The value to check.
   * @returns {boolean} Returns `true` if `value` is `NaN`, else `false`.
   */
  function baseIsNaN(value) {
    return value !== value;
  }

  /**
   * The base implementation of `_.mean` and `_.meanBy` without support for
   * iteratee shorthands.
   *
   * @private
   * @param {Array} array The array to iterate over.
   * @param {Function} iteratee The function invoked per iteration.
   * @returns {number} Returns the mean.
   */
  function baseMean(array, iteratee) {
    var length = array == null ? 0 : array.length;
    return length ? (baseSum(array, iteratee) / length) : NAN;
  }

  /**
   * The base implementation of `_.property` without support for deep paths.
   *
   * @private
   * @param {string} key The key of the property to get.
   * @returns {Function} Returns the new accessor function.
   */
  function baseProperty(key) {
    return function(object) {
      return object == null ? undefined : object[key];
    };
  }

  /**
   * The base implementation of `_.propertyOf` without support for deep paths.
   *
   * @private
   * @param {Object} object The object to query.
   * @returns {Function} Returns the new accessor function.
   */
  function basePropertyOf(object) {
    return function(key) {
      return object == null ? undefined : object[key];
    };
  }

  /**
   * The base implementation of `_.reduce` and `_.reduceRight`, without support
   * for iteratee shorthands, which iterates over `collection` using `eachFunc`.
   *
   * @private
   * @param {Array|Object} collection The collection to iterate over.
   * @param {Function} iteratee The function invoked per iteration.
   * @param {*} accumulator The initial value.
   * @param {boolean} initAccum Specify using the first or last element of
   *  `collection` as the initial value.
   * @param {Function} eachFunc The function to iterate over `collection`.
   * @returns {*} Returns the accumulated value.
   */
  function baseReduce(collection, iteratee, accumulator, initAccum, eachFunc) {
    eachFunc(collection, function(value, index, collection) {
      accumulator = initAccum
        ? (initAccum = false, value)
        : iteratee(accumulator, value, index, collection);
    });
    return accumulator;
  }

  /**
   * The base implementation of `_.sortBy` which uses `comparer` to define the
   * sort order of `array` and replaces criteria objects with their corresponding
   * values.
   *
   * @private
   * @param {Array} array The array to sort.
   * @param {Function} comparer The function to define sort order.
   * @returns {Array} Returns `array`.
   */
  function baseSortBy(array, comparer) {
    var length = array.length;

    array.sort(comparer);
    while (length--) {
      array[length] = array[length].value;
    }
    return array;
  }

  /**
   * The base implementation of `_.sum` and `_.sumBy` without support for
   * iteratee shorthands.
   *
   * @private
   * @param {Array} array The array to iterate over.
   * @param {Function} iteratee The function invoked per iteration.
   * @returns {number} Returns the sum.
   */
  function baseSum(array, iteratee) {
    var result,
        index = -1,
        length = array.length;

    while (++index < length) {
      var current = iteratee(array[index]);
      if (current !== undefined) {
        result = result === undefined ? current : (result + current);
      }
    }
    return result;
  }

  /**
   * The base implementation of `_.times` without support for iteratee shorthands
   * or max array length checks.
   *
   * @private
   * @param {number} n The number of times to invoke `iteratee`.
   * @param {Function} iteratee The function invoked per iteration.
   * @returns {Array} Returns the array of results.
   */
  function baseTimes(n, iteratee) {
    var index = -1,
        result = Array(n);

    while (++index < n) {
      result[index] = iteratee(index);
    }
    return result;
  }

  /**
   * The base implementation of `_.toPairs` and `_.toPairsIn` which creates an array
   * of key-value pairs for `object` corresponding to the property names of `props`.
   *
   * @private
   * @param {Object} object The object to query.
   * @param {Array} props The property names to get values for.
   * @returns {Object} Returns the key-value pairs.
   */
  function baseToPairs(object, props) {
    return arrayMap(props, function(key) {
      return [key, object[key]];
    });
  }

  /**
   * The base implementation of `_.unary` without support for storing metadata.
   *
   * @private
   * @param {Function} func The function to cap arguments for.
   * @returns {Function} Returns the new capped function.
   */
  function baseUnary(func) {
    return function(value) {
      return func(value);
    };
  }

  /**
   * The base implementation of `_.values` and `_.valuesIn` which creates an
   * array of `object` property values corresponding to the property names
   * of `props`.
   *
   * @private
   * @param {Object} object The object to query.
   * @param {Array} props The property names to get values for.
   * @returns {Object} Returns the array of property values.
   */
  function baseValues(object, props) {
    return arrayMap(props, function(key) {
      return object[key];
    });
  }

  /**
   * Checks if a `cache` value for `key` exists.
   *
   * @private
   * @param {Object} cache The cache to query.
   * @param {string} key The key of the entry to check.
   * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
   */
  function cacheHas(cache, key) {
    return cache.has(key);
  }

  /**
   * Used by `_.trim` and `_.trimStart` to get the index of the first string symbol
   * that is not found in the character symbols.
   *
   * @private
   * @param {Array} strSymbols The string symbols to inspect.
   * @param {Array} chrSymbols The character symbols to find.
   * @returns {number} Returns the index of the first unmatched string symbol.
   */
  function charsStartIndex(strSymbols, chrSymbols) {
    var index = -1,
        length = strSymbols.length;

    while (++index < length && baseIndexOf(chrSymbols, strSymbols[index], 0) > -1) {}
    return index;
  }

  /**
   * Used by `_.trim` and `_.trimEnd` to get the index of the last string symbol
   * that is not found in the character symbols.
   *
   * @private
   * @param {Array} strSymbols The string symbols to inspect.
   * @param {Array} chrSymbols The character symbols to find.
   * @returns {number} Returns the index of the last unmatched string symbol.
   */
  function charsEndIndex(strSymbols, chrSymbols) {
    var index = strSymbols.length;

    while (index-- && baseIndexOf(chrSymbols, strSymbols[index], 0) > -1) {}
    return index;
  }

  /**
   * Gets the number of `placeholder` occurrences in `array`.
   *
   * @private
   * @param {Array} array The array to inspect.
   * @param {*} placeholder The placeholder to search for.
   * @returns {number} Returns the placeholder count.
   */
  function countHolders(array, placeholder) {
    var length = array.length,
        result = 0;

    while (length--) {
      if (array[length] === placeholder) {
        ++result;
      }
    }
    return result;
  }

  /**
   * Used by `_.deburr` to convert Latin-1 Supplement and Latin Extended-A
   * letters to basic Latin letters.
   *
   * @private
   * @param {string} letter The matched letter to deburr.
   * @returns {string} Returns the deburred letter.
   */
  var deburrLetter = basePropertyOf(deburredLetters);

  /**
   * Used by `_.escape` to convert characters to HTML entities.
   *
   * @private
   * @param {string} chr The matched character to escape.
   * @returns {string} Returns the escaped character.
   */
  var escapeHtmlChar = basePropertyOf(htmlEscapes);

  /**
   * Used by `_.template` to escape characters for inclusion in compiled string literals.
   *
   * @private
   * @param {string} chr The matched character to escape.
   * @returns {string} Returns the escaped character.
   */
  function escapeStringChar(chr) {
    return '\\' + stringEscapes[chr];
  }

  /**
   * Gets the value at `key` of `object`.
   *
   * @private
   * @param {Object} [object] The object to query.
   * @param {string} key The key of the property to get.
   * @returns {*} Returns the property value.
   */
  function getValue(object, key) {
    return object == null ? undefined : object[key];
  }

  /**
   * Checks if `string` contains Unicode symbols.
   *
   * @private
   * @param {string} string The string to inspect.
   * @returns {boolean} Returns `true` if a symbol is found, else `false`.
   */
  function hasUnicode(string) {
    return reHasUnicode.test(string);
  }

  /**
   * Checks if `string` contains a word composed of Unicode symbols.
   *
   * @private
   * @param {string} string The string to inspect.
   * @returns {boolean} Returns `true` if a word is found, else `false`.
   */
  function hasUnicodeWord(string) {
    return reHasUnicodeWord.test(string);
  }

  /**
   * Converts `iterator` to an array.
   *
   * @private
   * @param {Object} iterator The iterator to convert.
   * @returns {Array} Returns the converted array.
   */
  function iteratorToArray(iterator) {
    var data,
        result = [];

    while (!(data = iterator.next()).done) {
      result.push(data.value);
    }
    return result;
  }

  /**
   * Converts `map` to its key-value pairs.
   *
   * @private
   * @param {Object} map The map to convert.
   * @returns {Array} Returns the key-value pairs.
   */
  function mapToArray(map) {
    var index = -1,
        result = Array(map.size);

    map.forEach(function(value, key) {
      result[++index] = [key, value];
    });
    return result;
  }

  /**
   * Creates a unary function that invokes `func` with its argument transformed.
   *
   * @private
   * @param {Function} func The function to wrap.
   * @param {Function} transform The argument transform.
   * @returns {Function} Returns the new function.
   */
  function overArg(func, transform) {
    return function(arg) {
      return func(transform(arg));
    };
  }

  /**
   * Replaces all `placeholder` elements in `array` with an internal placeholder
   * and returns an array of their indexes.
   *
   * @private
   * @param {Array} array The array to modify.
   * @param {*} placeholder The placeholder to replace.
   * @returns {Array} Returns the new array of placeholder indexes.
   */
  function replaceHolders(array, placeholder) {
    var index = -1,
        length = array.length,
        resIndex = 0,
        result = [];

    while (++index < length) {
      var value = array[index];
      if (value === placeholder || value === PLACEHOLDER) {
        array[index] = PLACEHOLDER;
        result[resIndex++] = index;
      }
    }
    return result;
  }

  /**
   * Converts `set` to an array of its values.
   *
   * @private
   * @param {Object} set The set to convert.
   * @returns {Array} Returns the values.
   */
  function setToArray(set) {
    var index = -1,
        result = Array(set.size);

    set.forEach(function(value) {
      result[++index] = value;
    });
    return result;
  }

  /**
   * Converts `set` to its value-value pairs.
   *
   * @private
   * @param {Object} set The set to convert.
   * @returns {Array} Returns the value-value pairs.
   */
  function setToPairs(set) {
    var index = -1,
        result = Array(set.size);

    set.forEach(function(value) {
      result[++index] = [value, value];
    });
    return result;
  }

  /**
   * A specialized version of `_.indexOf` which performs strict equality
   * comparisons of values, i.e. `===`.
   *
   * @private
   * @param {Array} array The array to inspect.
   * @param {*} value The value to search for.
   * @param {number} fromIndex The index to search from.
   * @returns {number} Returns the index of the matched value, else `-1`.
   */
  function strictIndexOf(array, value, fromIndex) {
    var index = fromIndex - 1,
        length = array.length;

    while (++index < length) {
      if (array[index] === value) {
        return index;
      }
    }
    return -1;
  }

  /**
   * A specialized version of `_.lastIndexOf` which performs strict equality
   * comparisons of values, i.e. `===`.
   *
   * @private
   * @param {Array} array The array to inspect.
   * @param {*} value The value to search for.
   * @param {number} fromIndex The index to search from.
   * @returns {number} Returns the index of the matched value, else `-1`.
   */
  function strictLastIndexOf(array, value, fromIndex) {
    var index = fromIndex + 1;
    while (index--) {
      if (array[index] === value) {
        return index;
      }
    }
    return index;
  }

  /**
   * Gets the number of symbols in `string`.
   *
   * @private
   * @param {string} string The string to inspect.
   * @returns {number} Returns the string size.
   */
  function stringSize(string) {
    return hasUnicode(string)
      ? unicodeSize(string)
      : asciiSize(string);
  }

  /**
   * Converts `string` to an array.
   *
   * @private
   * @param {string} string The string to convert.
   * @returns {Array} Returns the converted array.
   */
  function stringToArray(string) {
    return hasUnicode(string)
      ? unicodeToArray(string)
      : asciiToArray(string);
  }

  /**
   * Used by `_.unescape` to convert HTML entities to characters.
   *
   * @private
   * @param {string} chr The matched character to unescape.
   * @returns {string} Returns the unescaped character.
   */
  var unescapeHtmlChar = basePropertyOf(htmlUnescapes);

  /**
   * Gets the size of a Unicode `string`.
   *
   * @private
   * @param {string} string The string inspect.
   * @returns {number} Returns the string size.
   */
  function unicodeSize(string) {
    var result = reUnicode.lastIndex = 0;
    while (reUnicode.test(string)) {
      ++result;
    }
    return result;
  }

  /**
   * Converts a Unicode `string` to an array.
   *
   * @private
   * @param {string} string The string to convert.
   * @returns {Array} Returns the converted array.
   */
  function unicodeToArray(string) {
    return string.match(reUnicode) || [];
  }

  /**
   * Splits a Unicode `string` into an array of its words.
   *
   * @private
   * @param {string} The string to inspect.
   * @returns {Array} Returns the words of `string`.
   */
  function unicodeWords(string) {
    return string.match(reUnicodeWord) || [];
  }

  /*--------------------------------------------------------------------------*/

  /**
   * Create a new pristine `lodash` function using the `context` object.
   *
   * @static
   * @memberOf _
   * @since 1.1.0
   * @category Util
   * @param {Object} [context=root] The context object.
   * @returns {Function} Returns a new `lodash` function.
   * @example
   *
   * _.mixin({ 'foo': _.constant('foo') });
   *
   * var lodash = _.runInContext();
   * lodash.mixin({ 'bar': lodash.constant('bar') });
   *
   * _.isFunction(_.foo);
   * // => true
   * _.isFunction(_.bar);
   * // => false
   *
   * lodash.isFunction(lodash.foo);
   * // => false
   * lodash.isFunction(lodash.bar);
   * // => true
   *
   * // Create a suped-up `defer` in Node.js.
   * var defer = _.runInContext({ 'setTimeout': setImmediate }).defer;
   */
  var runInContext = (function runInContext(context) {
    context = context == null ? root : _.defaults(root.Object(), context, _.pick(root, contextProps));

    /** Built-in constructor references. */
    var Array = context.Array,
        Date = context.Date,
        Error = context.Error,
        Function = context.Function,
        Math = context.Math,
        Object = context.Object,
        RegExp = context.RegExp,
        String = context.String,
        TypeError = context.TypeError;

    /** Used for built-in method references. */
    var arrayProto = Array.prototype,
        funcProto = Function.prototype,
        objectProto = Object.prototype;

    /** Used to detect overreaching core-js shims. */
    var coreJsData = context['__core-js_shared__'];

    /** Used to resolve the decompiled source of functions. */
    var funcToString = funcProto.toString;

    /** Used to check objects for own properties. */
    var hasOwnProperty = objectProto.hasOwnProperty;

    /** Used to generate unique IDs. */
    var idCounter = 0;

    /** Used to detect methods masquerading as native. */
    var maskSrcKey = (function() {
      var uid = /[^.]+$/.exec(coreJsData && coreJsData.keys && coreJsData.keys.IE_PROTO || '');
      return uid ? ('Symbol(src)_1.' + uid) : '';
    }());

    /**
     * Used to resolve the
     * [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
     * of values.
     */
    var nativeObjectToString = objectProto.toString;

    /** Used to infer the `Object` constructor. */
    var objectCtorString = funcToString.call(Object);

    /** Used to restore the original `_` reference in `_.noConflict`. */
    var oldDash = root._;

    /** Used to detect if a method is native. */
    var reIsNative = RegExp('^' +
      funcToString.call(hasOwnProperty).replace(reRegExpChar, '\\$&')
      .replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, '$1.*?') + '$'
    );

    /** Built-in value references. */
    var Buffer = moduleExports ? context.Buffer : undefined,
        Symbol = context.Symbol,
        Uint8Array = context.Uint8Array,
        allocUnsafe = Buffer ? Buffer.allocUnsafe : undefined,
        getPrototype = overArg(Object.getPrototypeOf, Object),
        objectCreate = Object.create,
        propertyIsEnumerable = objectProto.propertyIsEnumerable,
        splice = arrayProto.splice,
        spreadableSymbol = Symbol ? Symbol.isConcatSpreadable : undefined,
        symIterator = Symbol ? Symbol.iterator : undefined,
        symToStringTag = Symbol ? Symbol.toStringTag : undefined;

    var defineProperty = (function() {
      try {
        var func = getNative(Object, 'defineProperty');
        func({}, '', {});
        return func;
      } catch (e) {}
    }());

    /** Mocked built-ins. */
    var ctxClearTimeout = context.clearTimeout !== root.clearTimeout && context.clearTimeout,
        ctxNow = Date && Date.now !== root.Date.now && Date.now,
        ctxSetTimeout = context.setTimeout !== root.setTimeout && context.setTimeout;

    /* Built-in method references for those with the same name as other `lodash` methods. */
    var nativeCeil = Math.ceil,
        nativeFloor = Math.floor,
        nativeGetSymbols = Object.getOwnPropertySymbols,
        nativeIsBuffer = Buffer ? Buffer.isBuffer : undefined,
        nativeIsFinite = context.isFinite,
        nativeJoin = arrayProto.join,
        nativeKeys = overArg(Object.keys, Object),
        nativeMax = Math.max,
        nativeMin = Math.min,
        nativeNow = Date.now,
        nativeParseInt = context.parseInt,
        nativeRandom = Math.random,
        nativeReverse = arrayProto.reverse;

    /* Built-in method references that are verified to be native. */
    var DataView = getNative(context, 'DataView'),
        Map = getNative(context, 'Map'),
        Promise = getNative(context, 'Promise'),
        Set = getNative(context, 'Set'),
        WeakMap = getNative(context, 'WeakMap'),
        nativeCreate = getNative(Object, 'create');

    /** Used to store function metadata. */
    var metaMap = WeakMap && new WeakMap;

    /** Used to lookup unminified function names. */
    var realNames = {};

    /** Used to detect maps, sets, and weakmaps. */
    var dataViewCtorString = toSource(DataView),
        mapCtorString = toSource(Map),
        promiseCtorString = toSource(Promise),
        setCtorString = toSource(Set),
        weakMapCtorString = toSource(WeakMap);

    /** Used to convert symbols to primitives and strings. */
    var symbolProto = Symbol ? Symbol.prototype : undefined,
        symbolValueOf = symbolProto ? symbolProto.valueOf : undefined,
        symbolToString = symbolProto ? symbolProto.toString : undefined;

    /*------------------------------------------------------------------------*/

    /**
     * Creates a `lodash` object which wraps `value` to enable implicit method
     * chain sequences. Methods that operate on and return arrays, collections,
     * and functions can be chained together. Methods that retrieve a single value
     * or may return a primitive value will automatically end the chain sequence
     * and return the unwrapped value. Otherwise, the value must be unwrapped
     * with `_#value`.
     *
     * Explicit chain sequences, which must be unwrapped with `_#value`, may be
     * enabled using `_.chain`.
     *
     * The execution of chained methods is lazy, that is, it's deferred until
     * `_#value` is implicitly or explicitly called.
     *
     * Lazy evaluation allows several methods to support shortcut fusion.
     * Shortcut fusion is an optimization to merge iteratee calls; this avoids
     * the creation of intermediate arrays and can greatly reduce the number of
     * iteratee executions. Sections of a chain sequence qualify for shortcut
     * fusion if the section is applied to an array and iteratees accept only
     * one argument. The heuristic for whether a section qualifies for shortcut
     * fusion is subject to change.
     *
     * Chaining is supported in custom builds as long as the `_#value` method is
     * directly or indirectly included in the build.
     *
     * In addition to lodash methods, wrappers have `Array` and `String` methods.
     *
     * The wrapper `Array` methods are:
     * `concat`, `join`, `pop`, `push`, `shift`, `sort`, `splice`, and `unshift`
     *
     * The wrapper `String` methods are:
     * `replace` and `split`
     *
     * The wrapper methods that support shortcut fusion are:
     * `at`, `compact`, `drop`, `dropRight`, `dropWhile`, `filter`, `find`,
     * `findLast`, `head`, `initial`, `last`, `map`, `reject`, `reverse`, `slice`,
     * `tail`, `take`, `takeRight`, `takeRightWhile`, `takeWhile`, and `toArray`
     *
     * The chainable wrapper methods are:
     * `after`, `ary`, `assign`, `assignIn`, `assignInWith`, `assignWith`, `at`,
     * `before`, `bind`, `bindAll`, `bindKey`, `castArray`, `chain`, `chunk`,
     * `commit`, `compact`, `concat`, `conforms`, `constant`, `countBy`, `create`,
     * `curry`, `debounce`, `defaults`, `defaultsDeep`, `defer`, `delay`,
     * `difference`, `differenceBy`, `differenceWith`, `drop`, `dropRight`,
     * `dropRightWhile`, `dropWhile`, `extend`, `extendWith`, `fill`, `filter`,
     * `flatMap`, `flatMapDeep`, `flatMapDepth`, `flatten`, `flattenDeep`,
     * `flattenDepth`, `flip`, `flow`, `flowRight`, `fromPairs`, `functions`,
     * `functionsIn`, `groupBy`, `initial`, `intersection`, `intersectionBy`,
     * `intersectionWith`, `invert`, `invertBy`, `invokeMap`, `iteratee`, `keyBy`,
     * `keys`, `keysIn`, `map`, `mapKeys`, `mapValues`, `matches`, `matchesProperty`,
     * `memoize`, `merge`, `mergeWith`, `method`, `methodOf`, `mixin`, `negate`,
     * `nthArg`, `omit`, `omitBy`, `once`, `orderBy`, `over`, `overArgs`,
     * `overEvery`, `overSome`, `partial`, `partialRight`, `partition`, `pick`,
     * `pickBy`, `plant`, `property`, `propertyOf`, `pull`, `pullAll`, `pullAllBy`,
     * `pullAllWith`, `pullAt`, `push`, `range`, `rangeRight`, `rearg`, `reject`,
     * `remove`, `rest`, `reverse`, `sampleSize`, `set`, `setWith`, `shuffle`,
     * `slice`, `sort`, `sortBy`, `splice`, `spread`, `tail`, `take`, `takeRight`,
     * `takeRightWhile`, `takeWhile`, `tap`, `throttle`, `thru`, `toArray`,
     * `toPairs`, `toPairsIn`, `toPath`, `toPlainObject`, `transform`, `unary`,
     * `union`, `unionBy`, `unionWith`, `uniq`, `uniqBy`, `uniqWith`, `unset`,
     * `unshift`, `unzip`, `unzipWith`, `update`, `updateWith`, `values`,
     * `valuesIn`, `without`, `wrap`, `xor`, `xorBy`, `xorWith`, `zip`,
     * `zipObject`, `zipObjectDeep`, and `zipWith`
     *
     * The wrapper methods that are **not** chainable by default are:
     * `add`, `attempt`, `camelCase`, `capitalize`, `ceil`, `clamp`, `clone`,
     * `cloneDeep`, `cloneDeepWith`, `cloneWith`, `conformsTo`, `deburr`,
     * `defaultTo`, `divide`, `each`, `eachRight`, `endsWith`, `eq`, `escape`,
     * `escapeRegExp`, `every`, `find`, `findIndex`, `findKey`, `findLast`,
     * `findLastIndex`, `findLastKey`, `first`, `floor`, `forEach`, `forEachRight`,
     * `forIn`, `forInRight`, `forOwn`, `forOwnRight`, `get`, `gt`, `gte`, `has`,
     * `hasIn`, `head`, `identity`, `includes`, `indexOf`, `inRange`, `invoke`,
     * `isArguments`, `isArray`, `isArrayBuffer`, `isArrayLike`, `isArrayLikeObject`,
     * `isBoolean`, `isBuffer`, `isDate`, `isElement`, `isEmpty`, `isEqual`,
     * `isEqualWith`, `isError`, `isFinite`, `isFunction`, `isInteger`, `isLength`,
     * `isMap`, `isMatch`, `isMatchWith`, `isNaN`, `isNative`, `isNil`, `isNull`,
     * `isNumber`, `isObject`, `isObjectLike`, `isPlainObject`, `isRegExp`,
     * `isSafeInteger`, `isSet`, `isString`, `isUndefined`, `isTypedArray`,
     * `isWeakMap`, `isWeakSet`, `join`, `kebabCase`, `last`, `lastIndexOf`,
     * `lowerCase`, `lowerFirst`, `lt`, `lte`, `max`, `maxBy`, `mean`, `meanBy`,
     * `min`, `minBy`, `multiply`, `noConflict`, `noop`, `now`, `nth`, `pad`,
     * `padEnd`, `padStart`, `parseInt`, `pop`, `random`, `reduce`, `reduceRight`,
     * `repeat`, `result`, `round`, `runInContext`, `sample`, `shift`, `size`,
     * `snakeCase`, `some`, `sortedIndex`, `sortedIndexBy`, `sortedLastIndex`,
     * `sortedLastIndexBy`, `startCase`, `startsWith`, `stubArray`, `stubFalse`,
     * `stubObject`, `stubString`, `stubTrue`, `subtract`, `sum`, `sumBy`,
     * `template`, `times`, `toFinite`, `toInteger`, `toJSON`, `toLength`,
     * `toLower`, `toNumber`, `toSafeInteger`, `toString`, `toUpper`, `trim`,
     * `trimEnd`, `trimStart`, `truncate`, `unescape`, `uniqueId`, `upperCase`,
     * `upperFirst`, `value`, and `words`
     *
     * @name _
     * @constructor
     * @category Seq
     * @param {*} value The value to wrap in a `lodash` instance.
     * @returns {Object} Returns the new `lodash` wrapper instance.
     * @example
     *
     * function square(n) {
     *   return n * n;
     * }
     *
     * var wrapped = _([1, 2, 3]);
     *
     * // Returns an unwrapped value.
     * wrapped.reduce(_.add);
     * // => 6
     *
     * // Returns a wrapped value.
     * var squares = wrapped.map(square);
     *
     * _.isArray(squares);
     * // => false
     *
     * _.isArray(squares.value());
     * // => true
     */
    function lodash(value) {
      if (isObjectLike(value) && !isArray(value) && !(value instanceof LazyWrapper)) {
        if (value instanceof LodashWrapper) {
          return value;
        }
        if (hasOwnProperty.call(value, '__wrapped__')) {
          return wrapperClone(value);
        }
      }
      return new LodashWrapper(value);
    }

    /**
     * The base implementation of `_.create` without support for assigning
     * properties to the created object.
     *
     * @private
     * @param {Object} proto The object to inherit from.
     * @returns {Object} Returns the new object.
     */
    var baseCreate = (function() {
      function object() {}
      return function(proto) {
        if (!isObject(proto)) {
          return {};
        }
        if (objectCreate) {
          return objectCreate(proto);
        }
        object.prototype = proto;
        var result = new object;
        object.prototype = undefined;
        return result;
      };
    }());

    /**
     * The function whose prototype chain sequence wrappers inherit from.
     *
     * @private
     */
    function baseLodash() {
      // No operation performed.
    }

    /**
     * The base constructor for creating `lodash` wrapper objects.
     *
     * @private
     * @param {*} value The value to wrap.
     * @param {boolean} [chainAll] Enable explicit method chain sequences.
     */
    function LodashWrapper(value, chainAll) {
      this.__wrapped__ = value;
      this.__actions__ = [];
      this.__chain__ = !!chainAll;
      this.__index__ = 0;
      this.__values__ = undefined;
    }

    /**
     * By default, the template delimiters used by lodash are like those in
     * embedded Ruby (ERB) as well as ES2015 template strings. Change the
     * following template settings to use alternative delimiters.
     *
     * @static
     * @memberOf _
     * @type {Object}
     */
    lodash.templateSettings = {

      /**
       * Used to detect `data` property values to be HTML-escaped.
       *
       * @memberOf _.templateSettings
       * @type {RegExp}
       */
      'escape': reEscape,

      /**
       * Used to detect code to be evaluated.
       *
       * @memberOf _.templateSettings
       * @type {RegExp}
       */
      'evaluate': reEvaluate,

      /**
       * Used to detect `data` property values to inject.
       *
       * @memberOf _.templateSettings
       * @type {RegExp}
       */
      'interpolate': reInterpolate,

      /**
       * Used to reference the data object in the template text.
       *
       * @memberOf _.templateSettings
       * @type {string}
       */
      'variable': '',

      /**
       * Used to import variables into the compiled template.
       *
       * @memberOf _.templateSettings
       * @type {Object}
       */
      'imports': {

        /**
         * A reference to the `lodash` function.
         *
         * @memberOf _.templateSettings.imports
         * @type {Function}
         */
        '_': lodash
      }
    };

    // Ensure wrappers are instances of `baseLodash`.
    lodash.prototype = baseLodash.prototype;
    lodash.prototype.constructor = lodash;

    LodashWrapper.prototype = baseCreate(baseLodash.prototype);
    LodashWrapper.prototype.constructor = LodashWrapper;

    /*------------------------------------------------------------------------*/

    /**
     * Creates a lazy wrapper object which wraps `value` to enable lazy evaluation.
     *
     * @private
     * @constructor
     * @param {*} value The value to wrap.
     */
    function LazyWrapper(value) {
      this.__wrapped__ = value;
      this.__actions__ = [];
      this.__dir__ = 1;
      this.__filtered__ = false;
      this.__iteratees__ = [];
      this.__takeCount__ = MAX_ARRAY_LENGTH;
      this.__views__ = [];
    }

    /**
     * Creates a clone of the lazy wrapper object.
     *
     * @private
     * @name clone
     * @memberOf LazyWrapper
     * @returns {Object} Returns the cloned `LazyWrapper` object.
     */
    function lazyClone() {
      var result = new LazyWrapper(this.__wrapped__);
      result.__actions__ = copyArray(this.__actions__);
      result.__dir__ = this.__dir__;
      result.__filtered__ = this.__filtered__;
      result.__iteratees__ = copyArray(this.__iteratees__);
      result.__takeCount__ = this.__takeCount__;
      result.__views__ = copyArray(this.__views__);
      return result;
    }

    /**
     * Reverses the direction of lazy iteration.
     *
     * @private
     * @name reverse
     * @memberOf LazyWrapper
     * @returns {Object} Returns the new reversed `LazyWrapper` object.
     */
    function lazyReverse() {
      if (this.__filtered__) {
        var result = new LazyWrapper(this);
        result.__dir__ = -1;
        result.__filtered__ = true;
      } else {
        result = this.clone();
        result.__dir__ *= -1;
      }
      return result;
    }

    /**
     * Extracts the unwrapped value from its lazy wrapper.
     *
     * @private
     * @name value
     * @memberOf LazyWrapper
     * @returns {*} Returns the unwrapped value.
     */
    function lazyValue() {
      var array = this.__wrapped__.value(),
          dir = this.__dir__,
          isArr = isArray(array),
          isRight = dir < 0,
          arrLength = isArr ? array.length : 0,
          view = getView(0, arrLength, this.__views__),
          start = view.start,
          end = view.end,
          length = end - start,
          index = isRight ? end : (start - 1),
          iteratees = this.__iteratees__,
          iterLength = iteratees.length,
          resIndex = 0,
          takeCount = nativeMin(length, this.__takeCount__);

      if (!isArr || (!isRight && arrLength == length && takeCount == length)) {
        return baseWrapperValue(array, this.__actions__);
      }
      var result = [];

      outer:
      while (length-- && resIndex < takeCount) {
        index += dir;

        var iterIndex = -1,
            value = array[index];

        while (++iterIndex < iterLength) {
          var data = iteratees[iterIndex],
              iteratee = data.iteratee,
              type = data.type,
              computed = iteratee(value);

          if (type == LAZY_MAP_FLAG) {
            value = computed;
          } else if (!computed) {
            if (type == LAZY_FILTER_FLAG) {
              continue outer;
            } else {
              break outer;
            }
          }
        }
        result[resIndex++] = value;
      }
      return result;
    }

    // Ensure `LazyWrapper` is an instance of `baseLodash`.
    LazyWrapper.prototype = baseCreate(baseLodash.prototype);
    LazyWrapper.prototype.constructor = LazyWrapper;

    /*------------------------------------------------------------------------*/

    /**
     * Creates a hash object.
     *
     * @private
     * @constructor
     * @param {Array} [entries] The key-value pairs to cache.
     */
    function Hash(entries) {
      var index = -1,
          length = entries == null ? 0 : entries.length;

      this.clear();
      while (++index < length) {
        var entry = entries[index];
        this.set(entry[0], entry[1]);
      }
    }

    /**
     * Removes all key-value entries from the hash.
     *
     * @private
     * @name clear
     * @memberOf Hash
     */
    function hashClear() {
      this.__data__ = nativeCreate ? nativeCreate(null) : {};
      this.size = 0;
    }

    /**
     * Removes `key` and its value from the hash.
     *
     * @private
     * @name delete
     * @memberOf Hash
     * @param {Object} hash The hash to modify.
     * @param {string} key The key of the value to remove.
     * @returns {boolean} Returns `true` if the entry was removed, else `false`.
     */
    function hashDelete(key) {
      var result = this.has(key) && delete this.__data__[key];
      this.size -= result ? 1 : 0;
      return result;
    }

    /**
     * Gets the hash value for `key`.
     *
     * @private
     * @name get
     * @memberOf Hash
     * @param {string} key The key of the value to get.
     * @returns {*} Returns the entry value.
     */
    function hashGet(key) {
      var data = this.__data__;
      if (nativeCreate) {
        var result = data[key];
        return result === HASH_UNDEFINED ? undefined : result;
      }
      return hasOwnProperty.call(data, key) ? data[key] : undefined;
    }

    /**
     * Checks if a hash value for `key` exists.
     *
     * @private
     * @name has
     * @memberOf Hash
     * @param {string} key The key of the entry to check.
     * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
     */
    function hashHas(key) {
      var data = this.__data__;
      return nativeCreate ? (data[key] !== undefined) : hasOwnProperty.call(data, key);
    }

    /**
     * Sets the hash `key` to `value`.
     *
     * @private
     * @name set
     * @memberOf Hash
     * @param {string} key The key of the value to set.
     * @param {*} value The value to set.
     * @returns {Object} Returns the hash instance.
     */
    function hashSet(key, value) {
      var data = this.__data__;
      this.size += this.has(key) ? 0 : 1;
      data[key] = (nativeCreate && value === undefined) ? HASH_UNDEFINED : value;
      return this;
    }

    // Add methods to `Hash`.
    Hash.prototype.clear = hashClear;
    Hash.prototype['delete'] = hashDelete;
    Hash.prototype.get = hashGet;
    Hash.prototype.has = hashHas;
    Hash.prototype.set = hashSet;

    /*------------------------------------------------------------------------*/

    /**
     * Creates an list cache object.
     *
     * @private
     * @constructor
     * @param {Array} [entries] The key-value pairs to cache.
     */
    function ListCache(entries) {
      var index = -1,
          length = entries == null ? 0 : entries.length;

      this.clear();
      while (++index < length) {
        var entry = entries[index];
        this.set(entry[0], entry[1]);
      }
    }

    /**
     * Removes all key-value entries from the list cache.
     *
     * @private
     * @name clear
     * @memberOf ListCache
     */
    function listCacheClear() {
      this.__data__ = [];
      this.size = 0;
    }

    /**
     * Removes `key` and its value from the list cache.
     *
     * @private
     * @name delete
     * @memberOf ListCache
     * @param {string} key The key of the value to remove.
     * @returns {boolean} Returns `true` if the entry was removed, else `false`.
     */
    function listCacheDelete(key) {
      var data = this.__data__,
          index = assocIndexOf(data, key);

      if (index < 0) {
        return false;
      }
      var lastIndex = data.length - 1;
      if (index == lastIndex) {
        data.pop();
      } else {
        splice.call(data, index, 1);
      }
      --this.size;
      return true;
    }

    /**
     * Gets the list cache value for `key`.
     *
     * @private
     * @name get
     * @memberOf ListCache
     * @param {string} key The key of the value to get.
     * @returns {*} Returns the entry value.
     */
    function listCacheGet(key) {
      var data = this.__data__,
          index = assocIndexOf(data, key);

      return index < 0 ? undefined : data[index][1];
    }

    /**
     * Checks if a list cache value for `key` exists.
     *
     * @private
     * @name has
     * @memberOf ListCache
     * @param {string} key The key of the entry to check.
     * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
     */
    function listCacheHas(key) {
      return assocIndexOf(this.__data__, key) > -1;
    }

    /**
     * Sets the list cache `key` to `value`.
     *
     * @private
     * @name set
     * @memberOf ListCache
     * @param {string} key The key of the value to set.
     * @param {*} value The value to set.
     * @returns {Object} Returns the list cache instance.
     */
    function listCacheSet(key, value) {
      var data = this.__data__,
          index = assocIndexOf(data, key);

      if (index < 0) {
        ++this.size;
        data.push([key, value]);
      } else {
        data[index][1] = value;
      }
      return this;
    }

    // Add methods to `ListCache`.
    ListCache.prototype.clear = listCacheClear;
    ListCache.prototype['delete'] = listCacheDelete;
    ListCache.prototype.get = listCacheGet;
    ListCache.prototype.has = listCacheHas;
    ListCache.prototype.set = listCacheSet;

    /*------------------------------------------------------------------------*/

    /**
     * Creates a map cache object to store key-value pairs.
     *
     * @private
     * @constructor
     * @param {Array} [entries] The key-value pairs to cache.
     */
    function MapCache(entries) {
      var index = -1,
          length = entries == null ? 0 : entries.length;

      this.clear();
      while (++index < length) {
        var entry = entries[index];
        this.set(entry[0], entry[1]);
      }
    }

    /**
     * Removes all key-value entries from the map.
     *
     * @private
     * @name clear
     * @memberOf MapCache
     */
    function mapCacheClear() {
      this.size = 0;
      this.__data__ = {
        'hash': new Hash,
        'map': new (Map || ListCache),
        'string': new Hash
      };
    }

    /**
     * Removes `key` and its value from the map.
     *
     * @private
     * @name delete
     * @memberOf MapCache
     * @param {string} key The key of the value to remove.
     * @returns {boolean} Returns `true` if the entry was removed, else `false`.
     */
    function mapCacheDelete(key) {
      var result = getMapData(this, key)['delete'](key);
      this.size -= result ? 1 : 0;
      return result;
    }

    /**
     * Gets the map value for `key`.
     *
     * @private
     * @name get
     * @memberOf MapCache
     * @param {string} key The key of the value to get.
     * @returns {*} Returns the entry value.
     */
    function mapCacheGet(key) {
      return getMapData(this, key).get(key);
    }

    /**
     * Checks if a map value for `key` exists.
     *
     * @private
     * @name has
     * @memberOf MapCache
     * @param {string} key The key of the entry to check.
     * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
     */
    function mapCacheHas(key) {
      return getMapData(this, key).has(key);
    }

    /**
     * Sets the map `key` to `value`.
     *
     * @private
     * @name set
     * @memberOf MapCache
     * @param {string} key The key of the value to set.
     * @param {*} value The value to set.
     * @returns {Object} Returns the map cache instance.
     */
    function mapCacheSet(key, value) {
      var data = getMapData(this, key),
          size = data.size;

      data.set(key, value);
      this.size += data.size == size ? 0 : 1;
      return this;
    }

    // Add methods to `MapCache`.
    MapCache.prototype.clear = mapCacheClear;
    MapCache.prototype['delete'] = mapCacheDelete;
    MapCache.prototype.get = mapCacheGet;
    MapCache.prototype.has = mapCacheHas;
    MapCache.prototype.set = mapCacheSet;

    /*------------------------------------------------------------------------*/

    /**
     *
     * Creates an array cache object to store unique values.
     *
     * @private
     * @constructor
     * @param {Array} [values] The values to cache.
     */
    function SetCache(values) {
      var index = -1,
          length = values == null ? 0 : values.length;

      this.__data__ = new MapCache;
      while (++index < length) {
        this.add(values[index]);
      }
    }

    /**
     * Adds `value` to the array cache.
     *
     * @private
     * @name add
     * @memberOf SetCache
     * @alias push
     * @param {*} value The value to cache.
     * @returns {Object} Returns the cache instance.
     */
    function setCacheAdd(value) {
      this.__data__.set(value, HASH_UNDEFINED);
      return this;
    }

    /**
     * Checks if `value` is in the array cache.
     *
     * @private
     * @name has
     * @memberOf SetCache
     * @param {*} value The value to search for.
     * @returns {number} Returns `true` if `value` is found, else `false`.
     */
    function setCacheHas(value) {
      return this.__data__.has(value);
    }

    // Add methods to `SetCache`.
    SetCache.prototype.add = SetCache.prototype.push = setCacheAdd;
    SetCache.prototype.has = setCacheHas;

    /*------------------------------------------------------------------------*/

    /**
     * Creates a stack cache object to store key-value pairs.
     *
     * @private
     * @constructor
     * @param {Array} [entries] The key-value pairs to cache.
     */
    function Stack(entries) {
      var data = this.__data__ = new ListCache(entries);
      this.size = data.size;
    }

    /**
     * Removes all key-value entries from the stack.
     *
     * @private
     * @name clear
     * @memberOf Stack
     */
    function stackClear() {
      this.__data__ = new ListCache;
      this.size = 0;
    }

    /**
     * Removes `key` and its value from the stack.
     *
     * @private
     * @name delete
     * @memberOf Stack
     * @param {string} key The key of the value to remove.
     * @returns {boolean} Returns `true` if the entry was removed, else `false`.
     */
    function stackDelete(key) {
      var data = this.__data__,
          result = data['delete'](key);

      this.size = data.size;
      return result;
    }

    /**
     * Gets the stack value for `key`.
     *
     * @private
     * @name get
     * @memberOf Stack
     * @param {string} key The key of the value to get.
     * @returns {*} Returns the entry value.
     */
    function stackGet(key) {
      return this.__data__.get(key);
    }

    /**
     * Checks if a stack value for `key` exists.
     *
     * @private
     * @name has
     * @memberOf Stack
     * @param {string} key The key of the entry to check.
     * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
     */
    function stackHas(key) {
      return this.__data__.has(key);
    }

    /**
     * Sets the stack `key` to `value`.
     *
     * @private
     * @name set
     * @memberOf Stack
     * @param {string} key The key of the value to set.
     * @param {*} value The value to set.
     * @returns {Object} Returns the stack cache instance.
     */
    function stackSet(key, value) {
      var data = this.__data__;
      if (data instanceof ListCache) {
        var pairs = data.__data__;
        if (!Map || (pairs.length < LARGE_ARRAY_SIZE - 1)) {
          pairs.push([key, value]);
          this.size = ++data.size;
          return this;
        }
        data = this.__data__ = new MapCache(pairs);
      }
      data.set(key, value);
      this.size = data.size;
      return this;
    }

    // Add methods to `Stack`.
    Stack.prototype.clear = stackClear;
    Stack.prototype['delete'] = stackDelete;
    Stack.prototype.get = stackGet;
    Stack.prototype.has = stackHas;
    Stack.prototype.set = stackSet;

    /*------------------------------------------------------------------------*/

    /**
     * Creates an array of the enumerable property names of the array-like `value`.
     *
     * @private
     * @param {*} value The value to query.
     * @param {boolean} inherited Specify returning inherited property names.
     * @returns {Array} Returns the array of property names.
     */
    function arrayLikeKeys(value, inherited) {
      var isArr = isArray(value),
          isArg = !isArr && isArguments(value),
          isBuff = !isArr && !isArg && isBuffer(value),
          isType = !isArr && !isArg && !isBuff && isTypedArray(value),
          skipIndexes = isArr || isArg || isBuff || isType,
          result = skipIndexes ? baseTimes(value.length, String) : [],
          length = result.length;

      for (var key in value) {
        if ((inherited || hasOwnProperty.call(value, key)) &&
            !(skipIndexes && (
               // Safari 9 has enumerable `arguments.length` in strict mode.
               key == 'length' ||
               // Node.js 0.10 has enumerable non-index properties on buffers.
               (isBuff && (key == 'offset' || key == 'parent')) ||
               // PhantomJS 2 has enumerable non-index properties on typed arrays.
               (isType && (key == 'buffer' || key == 'byteLength' || key == 'byteOffset')) ||
               // Skip index properties.
               isIndex(key, length)
            ))) {
          result.push(key);
        }
      }
      return result;
    }

    /**
     * A specialized version of `_.sample` for arrays.
     *
     * @private
     * @param {Array} array The array to sample.
     * @returns {*} Returns the random element.
     */
    function arraySample(array) {
      var length = array.length;
      return length ? array[baseRandom(0, length - 1)] : undefined;
    }

    /**
     * A specialized version of `_.sampleSize` for arrays.
     *
     * @private
     * @param {Array} array The array to sample.
     * @param {number} n The number of elements to sample.
     * @returns {Array} Returns the random elements.
     */
    function arraySampleSize(array, n) {
      return shuffleSelf(copyArray(array), baseClamp(n, 0, array.length));
    }

    /**
     * A specialized version of `_.shuffle` for arrays.
     *
     * @private
     * @param {Array} array The array to shuffle.
     * @returns {Array} Returns the new shuffled array.
     */
    function arrayShuffle(array) {
      return shuffleSelf(copyArray(array));
    }

    /**
     * This function is like `assignValue` except that it doesn't assign
     * `undefined` values.
     *
     * @private
     * @param {Object} object The object to modify.
     * @param {string} key The key of the property to assign.
     * @param {*} value The value to assign.
     */
    function assignMergeValue(object, key, value) {
      if ((value !== undefined && !eq(object[key], value)) ||
          (value === undefined && !(key in object))) {
        baseAssignValue(object, key, value);
      }
    }

    /**
     * Assigns `value` to `key` of `object` if the existing value is not equivalent
     * using [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
     * for equality comparisons.
     *
     * @private
     * @param {Object} object The object to modify.
     * @param {string} key The key of the property to assign.
     * @param {*} value The value to assign.
     */
    function assignValue(object, key, value) {
      var objValue = object[key];
      if (!(hasOwnProperty.call(object, key) && eq(objValue, value)) ||
          (value === undefined && !(key in object))) {
        baseAssignValue(object, key, value);
      }
    }

    /**
     * Gets the index at which the `key` is found in `array` of key-value pairs.
     *
     * @private
     * @param {Array} array The array to inspect.
     * @param {*} key The key to search for.
     * @returns {number} Returns the index of the matched value, else `-1`.
     */
    function assocIndexOf(array, key) {
      var length = array.length;
      while (length--) {
        if (eq(array[length][0], key)) {
          return length;
        }
      }
      return -1;
    }

    /**
     * Aggregates elements of `collection` on `accumulator` with keys transformed
     * by `iteratee` and values set by `setter`.
     *
     * @private
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} setter The function to set `accumulator` values.
     * @param {Function} iteratee The iteratee to transform keys.
     * @param {Object} accumulator The initial aggregated object.
     * @returns {Function} Returns `accumulator`.
     */
    function baseAggregator(collection, setter, iteratee, accumulator) {
      baseEach(collection, function(value, key, collection) {
        setter(accumulator, value, iteratee(value), collection);
      });
      return accumulator;
    }

    /**
     * The base implementation of `_.assign` without support for multiple sources
     * or `customizer` functions.
     *
     * @private
     * @param {Object} object The destination object.
     * @param {Object} source The source object.
     * @returns {Object} Returns `object`.
     */
    function baseAssign(object, source) {
      return object && copyObject(source, keys(source), object);
    }

    /**
     * The base implementation of `_.assignIn` without support for multiple sources
     * or `customizer` functions.
     *
     * @private
     * @param {Object} object The destination object.
     * @param {Object} source The source object.
     * @returns {Object} Returns `object`.
     */
    function baseAssignIn(object, source) {
      return object && copyObject(source, keysIn(source), object);
    }

    /**
     * The base implementation of `assignValue` and `assignMergeValue` without
     * value checks.
     *
     * @private
     * @param {Object} object The object to modify.
     * @param {string} key The key of the property to assign.
     * @param {*} value The value to assign.
     */
    function baseAssignValue(object, key, value) {
      if (key == '__proto__' && defineProperty) {
        defineProperty(object, key, {
          'configurable': true,
          'enumerable': true,
          'value': value,
          'writable': true
        });
      } else {
        object[key] = value;
      }
    }

    /**
     * The base implementation of `_.at` without support for individual paths.
     *
     * @private
     * @param {Object} object The object to iterate over.
     * @param {string[]} paths The property paths to pick.
     * @returns {Array} Returns the picked elements.
     */
    function baseAt(object, paths) {
      var index = -1,
          length = paths.length,
          result = Array(length),
          skip = object == null;

      while (++index < length) {
        result[index] = skip ? undefined : get(object, paths[index]);
      }
      return result;
    }

    /**
     * The base implementation of `_.clamp` which doesn't coerce arguments.
     *
     * @private
     * @param {number} number The number to clamp.
     * @param {number} [lower] The lower bound.
     * @param {number} upper The upper bound.
     * @returns {number} Returns the clamped number.
     */
    function baseClamp(number, lower, upper) {
      if (number === number) {
        if (upper !== undefined) {
          number = number <= upper ? number : upper;
        }
        if (lower !== undefined) {
          number = number >= lower ? number : lower;
        }
      }
      return number;
    }

    /**
     * The base implementation of `_.clone` and `_.cloneDeep` which tracks
     * traversed objects.
     *
     * @private
     * @param {*} value The value to clone.
     * @param {boolean} bitmask The bitmask flags.
     *  1 - Deep clone
     *  2 - Flatten inherited properties
     *  4 - Clone symbols
     * @param {Function} [customizer] The function to customize cloning.
     * @param {string} [key] The key of `value`.
     * @param {Object} [object] The parent object of `value`.
     * @param {Object} [stack] Tracks traversed objects and their clone counterparts.
     * @returns {*} Returns the cloned value.
     */
    function baseClone(value, bitmask, customizer, key, object, stack) {
      var result,
          isDeep = bitmask & CLONE_DEEP_FLAG,
          isFlat = bitmask & CLONE_FLAT_FLAG,
          isFull = bitmask & CLONE_SYMBOLS_FLAG;

      if (customizer) {
        result = object ? customizer(value, key, object, stack) : customizer(value);
      }
      if (result !== undefined) {
        return result;
      }
      if (!isObject(value)) {
        return value;
      }
      var isArr = isArray(value);
      if (isArr) {
        result = initCloneArray(value);
        if (!isDeep) {
          return copyArray(value, result);
        }
      } else {
        var tag = getTag(value),
            isFunc = tag == funcTag || tag == genTag;

        if (isBuffer(value)) {
          return cloneBuffer(value, isDeep);
        }
        if (tag == objectTag || tag == argsTag || (isFunc && !object)) {
          result = (isFlat || isFunc) ? {} : initCloneObject(value);
          if (!isDeep) {
            return isFlat
              ? copySymbolsIn(value, baseAssignIn(result, value))
              : copySymbols(value, baseAssign(result, value));
          }
        } else {
          if (!cloneableTags[tag]) {
            return object ? value : {};
          }
          result = initCloneByTag(value, tag, baseClone, isDeep);
        }
      }
      // Check for circular references and return its corresponding clone.
      stack || (stack = new Stack);
      var stacked = stack.get(value);
      if (stacked) {
        return stacked;
      }
      stack.set(value, result);

      var keysFunc = isFull
        ? (isFlat ? getAllKeysIn : getAllKeys)
        : (isFlat ? keysIn : keys);

      var props = isArr ? undefined : keysFunc(value);
      arrayEach(props || value, function(subValue, key) {
        if (props) {
          key = subValue;
          subValue = value[key];
        }
        // Recursively populate clone (susceptible to call stack limits).
        assignValue(result, key, baseClone(subValue, bitmask, customizer, key, value, stack));
      });
      return result;
    }

    /**
     * The base implementation of `_.conforms` which doesn't clone `source`.
     *
     * @private
     * @param {Object} source The object of property predicates to conform to.
     * @returns {Function} Returns the new spec function.
     */
    function baseConforms(source) {
      var props = keys(source);
      return function(object) {
        return baseConformsTo(object, source, props);
      };
    }

    /**
     * The base implementation of `_.conformsTo` which accepts `props` to check.
     *
     * @private
     * @param {Object} object The object to inspect.
     * @param {Object} source The object of property predicates to conform to.
     * @returns {boolean} Returns `true` if `object` conforms, else `false`.
     */
    function baseConformsTo(object, source, props) {
      var length = props.length;
      if (object == null) {
        return !length;
      }
      object = Object(object);
      while (length--) {
        var key = props[length],
            predicate = source[key],
            value = object[key];

        if ((value === undefined && !(key in object)) || !predicate(value)) {
          return false;
        }
      }
      return true;
    }

    /**
     * The base implementation of `_.delay` and `_.defer` which accepts `args`
     * to provide to `func`.
     *
     * @private
     * @param {Function} func The function to delay.
     * @param {number} wait The number of milliseconds to delay invocation.
     * @param {Array} args The arguments to provide to `func`.
     * @returns {number|Object} Returns the timer id or timeout object.
     */
    function baseDelay(func, wait, args) {
      if (typeof func != 'function') {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      return setTimeout(function() { func.apply(undefined, args); }, wait);
    }

    /**
     * The base implementation of methods like `_.difference` without support
     * for excluding multiple arrays or iteratee shorthands.
     *
     * @private
     * @param {Array} array The array to inspect.
     * @param {Array} values The values to exclude.
     * @param {Function} [iteratee] The iteratee invoked per element.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns the new array of filtered values.
     */
    function baseDifference(array, values, iteratee, comparator) {
      var index = -1,
          includes = arrayIncludes,
          isCommon = true,
          length = array.length,
          result = [],
          valuesLength = values.length;

      if (!length) {
        return result;
      }
      if (iteratee) {
        values = arrayMap(values, baseUnary(iteratee));
      }
      if (comparator) {
        includes = arrayIncludesWith;
        isCommon = false;
      }
      else if (values.length >= LARGE_ARRAY_SIZE) {
        includes = cacheHas;
        isCommon = false;
        values = new SetCache(values);
      }
      outer:
      while (++index < length) {
        var value = array[index],
            computed = iteratee == null ? value : iteratee(value);

        value = (comparator || value !== 0) ? value : 0;
        if (isCommon && computed === computed) {
          var valuesIndex = valuesLength;
          while (valuesIndex--) {
            if (values[valuesIndex] === computed) {
              continue outer;
            }
          }
          result.push(value);
        }
        else if (!includes(values, computed, comparator)) {
          result.push(value);
        }
      }
      return result;
    }

    /**
     * The base implementation of `_.forEach` without support for iteratee shorthands.
     *
     * @private
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} iteratee The function invoked per iteration.
     * @returns {Array|Object} Returns `collection`.
     */
    var baseEach = createBaseEach(baseForOwn);

    /**
     * The base implementation of `_.forEachRight` without support for iteratee shorthands.
     *
     * @private
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} iteratee The function invoked per iteration.
     * @returns {Array|Object} Returns `collection`.
     */
    var baseEachRight = createBaseEach(baseForOwnRight, true);

    /**
     * The base implementation of `_.every` without support for iteratee shorthands.
     *
     * @private
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} predicate The function invoked per iteration.
     * @returns {boolean} Returns `true` if all elements pass the predicate check,
     *  else `false`
     */
    function baseEvery(collection, predicate) {
      var result = true;
      baseEach(collection, function(value, index, collection) {
        result = !!predicate(value, index, collection);
        return result;
      });
      return result;
    }

    /**
     * The base implementation of methods like `_.max` and `_.min` which accepts a
     * `comparator` to determine the extremum value.
     *
     * @private
     * @param {Array} array The array to iterate over.
     * @param {Function} iteratee The iteratee invoked per iteration.
     * @param {Function} comparator The comparator used to compare values.
     * @returns {*} Returns the extremum value.
     */
    function baseExtremum(array, iteratee, comparator) {
      var index = -1,
          length = array.length;

      while (++index < length) {
        var value = array[index],
            current = iteratee(value);

        if (current != null && (computed === undefined
              ? (current === current && !isSymbol(current))
              : comparator(current, computed)
            )) {
          var computed = current,
              result = value;
        }
      }
      return result;
    }

    /**
     * The base implementation of `_.fill` without an iteratee call guard.
     *
     * @private
     * @param {Array} array The array to fill.
     * @param {*} value The value to fill `array` with.
     * @param {number} [start=0] The start position.
     * @param {number} [end=array.length] The end position.
     * @returns {Array} Returns `array`.
     */
    function baseFill(array, value, start, end) {
      var length = array.length;

      start = toInteger(start);
      if (start < 0) {
        start = -start > length ? 0 : (length + start);
      }
      end = (end === undefined || end > length) ? length : toInteger(end);
      if (end < 0) {
        end += length;
      }
      end = start > end ? 0 : toLength(end);
      while (start < end) {
        array[start++] = value;
      }
      return array;
    }

    /**
     * The base implementation of `_.filter` without support for iteratee shorthands.
     *
     * @private
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} predicate The function invoked per iteration.
     * @returns {Array} Returns the new filtered array.
     */
    function baseFilter(collection, predicate) {
      var result = [];
      baseEach(collection, function(value, index, collection) {
        if (predicate(value, index, collection)) {
          result.push(value);
        }
      });
      return result;
    }

    /**
     * The base implementation of `_.flatten` with support for restricting flattening.
     *
     * @private
     * @param {Array} array The array to flatten.
     * @param {number} depth The maximum recursion depth.
     * @param {boolean} [predicate=isFlattenable] The function invoked per iteration.
     * @param {boolean} [isStrict] Restrict to values that pass `predicate` checks.
     * @param {Array} [result=[]] The initial result value.
     * @returns {Array} Returns the new flattened array.
     */
    function baseFlatten(array, depth, predicate, isStrict, result) {
      var index = -1,
          length = array.length;

      predicate || (predicate = isFlattenable);
      result || (result = []);

      while (++index < length) {
        var value = array[index];
        if (depth > 0 && predicate(value)) {
          if (depth > 1) {
            // Recursively flatten arrays (susceptible to call stack limits).
            baseFlatten(value, depth - 1, predicate, isStrict, result);
          } else {
            arrayPush(result, value);
          }
        } else if (!isStrict) {
          result[result.length] = value;
        }
      }
      return result;
    }

    /**
     * The base implementation of `baseForOwn` which iterates over `object`
     * properties returned by `keysFunc` and invokes `iteratee` for each property.
     * Iteratee functions may exit iteration early by explicitly returning `false`.
     *
     * @private
     * @param {Object} object The object to iterate over.
     * @param {Function} iteratee The function invoked per iteration.
     * @param {Function} keysFunc The function to get the keys of `object`.
     * @returns {Object} Returns `object`.
     */
    var baseFor = createBaseFor();

    /**
     * This function is like `baseFor` except that it iterates over properties
     * in the opposite order.
     *
     * @private
     * @param {Object} object The object to iterate over.
     * @param {Function} iteratee The function invoked per iteration.
     * @param {Function} keysFunc The function to get the keys of `object`.
     * @returns {Object} Returns `object`.
     */
    var baseForRight = createBaseFor(true);

    /**
     * The base implementation of `_.forOwn` without support for iteratee shorthands.
     *
     * @private
     * @param {Object} object The object to iterate over.
     * @param {Function} iteratee The function invoked per iteration.
     * @returns {Object} Returns `object`.
     */
    function baseForOwn(object, iteratee) {
      return object && baseFor(object, iteratee, keys);
    }

    /**
     * The base implementation of `_.forOwnRight` without support for iteratee shorthands.
     *
     * @private
     * @param {Object} object The object to iterate over.
     * @param {Function} iteratee The function invoked per iteration.
     * @returns {Object} Returns `object`.
     */
    function baseForOwnRight(object, iteratee) {
      return object && baseForRight(object, iteratee, keys);
    }

    /**
     * The base implementation of `_.functions` which creates an array of
     * `object` function property names filtered from `props`.
     *
     * @private
     * @param {Object} object The object to inspect.
     * @param {Array} props The property names to filter.
     * @returns {Array} Returns the function names.
     */
    function baseFunctions(object, props) {
      return arrayFilter(props, function(key) {
        return isFunction(object[key]);
      });
    }

    /**
     * The base implementation of `_.get` without support for default values.
     *
     * @private
     * @param {Object} object The object to query.
     * @param {Array|string} path The path of the property to get.
     * @returns {*} Returns the resolved value.
     */
    function baseGet(object, path) {
      path = castPath(path, object);

      var index = 0,
          length = path.length;

      while (object != null && index < length) {
        object = object[toKey(path[index++])];
      }
      return (index && index == length) ? object : undefined;
    }

    /**
     * The base implementation of `getAllKeys` and `getAllKeysIn` which uses
     * `keysFunc` and `symbolsFunc` to get the enumerable property names and
     * symbols of `object`.
     *
     * @private
     * @param {Object} object The object to query.
     * @param {Function} keysFunc The function to get the keys of `object`.
     * @param {Function} symbolsFunc The function to get the symbols of `object`.
     * @returns {Array} Returns the array of property names and symbols.
     */
    function baseGetAllKeys(object, keysFunc, symbolsFunc) {
      var result = keysFunc(object);
      return isArray(object) ? result : arrayPush(result, symbolsFunc(object));
    }

    /**
     * The base implementation of `getTag` without fallbacks for buggy environments.
     *
     * @private
     * @param {*} value The value to query.
     * @returns {string} Returns the `toStringTag`.
     */
    function baseGetTag(value) {
      if (value == null) {
        return value === undefined ? undefinedTag : nullTag;
      }
      return (symToStringTag && symToStringTag in Object(value))
        ? getRawTag(value)
        : objectToString(value);
    }

    /**
     * The base implementation of `_.gt` which doesn't coerce arguments.
     *
     * @private
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @returns {boolean} Returns `true` if `value` is greater than `other`,
     *  else `false`.
     */
    function baseGt(value, other) {
      return value > other;
    }

    /**
     * The base implementation of `_.has` without support for deep paths.
     *
     * @private
     * @param {Object} [object] The object to query.
     * @param {Array|string} key The key to check.
     * @returns {boolean} Returns `true` if `key` exists, else `false`.
     */
    function baseHas(object, key) {
      return object != null && hasOwnProperty.call(object, key);
    }

    /**
     * The base implementation of `_.hasIn` without support for deep paths.
     *
     * @private
     * @param {Object} [object] The object to query.
     * @param {Array|string} key The key to check.
     * @returns {boolean} Returns `true` if `key` exists, else `false`.
     */
    function baseHasIn(object, key) {
      return object != null && key in Object(object);
    }

    /**
     * The base implementation of `_.inRange` which doesn't coerce arguments.
     *
     * @private
     * @param {number} number The number to check.
     * @param {number} start The start of the range.
     * @param {number} end The end of the range.
     * @returns {boolean} Returns `true` if `number` is in the range, else `false`.
     */
    function baseInRange(number, start, end) {
      return number >= nativeMin(start, end) && number < nativeMax(start, end);
    }

    /**
     * The base implementation of methods like `_.intersection`, without support
     * for iteratee shorthands, that accepts an array of arrays to inspect.
     *
     * @private
     * @param {Array} arrays The arrays to inspect.
     * @param {Function} [iteratee] The iteratee invoked per element.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns the new array of shared values.
     */
    function baseIntersection(arrays, iteratee, comparator) {
      var includes = comparator ? arrayIncludesWith : arrayIncludes,
          length = arrays[0].length,
          othLength = arrays.length,
          othIndex = othLength,
          caches = Array(othLength),
          maxLength = Infinity,
          result = [];

      while (othIndex--) {
        var array = arrays[othIndex];
        if (othIndex && iteratee) {
          array = arrayMap(array, baseUnary(iteratee));
        }
        maxLength = nativeMin(array.length, maxLength);
        caches[othIndex] = !comparator && (iteratee || (length >= 120 && array.length >= 120))
          ? new SetCache(othIndex && array)
          : undefined;
      }
      array = arrays[0];

      var index = -1,
          seen = caches[0];

      outer:
      while (++index < length && result.length < maxLength) {
        var value = array[index],
            computed = iteratee ? iteratee(value) : value;

        value = (comparator || value !== 0) ? value : 0;
        if (!(seen
              ? cacheHas(seen, computed)
              : includes(result, computed, comparator)
            )) {
          othIndex = othLength;
          while (--othIndex) {
            var cache = caches[othIndex];
            if (!(cache
                  ? cacheHas(cache, computed)
                  : includes(arrays[othIndex], computed, comparator))
                ) {
              continue outer;
            }
          }
          if (seen) {
            seen.push(computed);
          }
          result.push(value);
        }
      }
      return result;
    }

    /**
     * The base implementation of `_.invert` and `_.invertBy` which inverts
     * `object` with values transformed by `iteratee` and set by `setter`.
     *
     * @private
     * @param {Object} object The object to iterate over.
     * @param {Function} setter The function to set `accumulator` values.
     * @param {Function} iteratee The iteratee to transform values.
     * @param {Object} accumulator The initial inverted object.
     * @returns {Function} Returns `accumulator`.
     */
    function baseInverter(object, setter, iteratee, accumulator) {
      baseForOwn(object, function(value, key, object) {
        setter(accumulator, iteratee(value), key, object);
      });
      return accumulator;
    }

    /**
     * The base implementation of `_.invoke` without support for individual
     * method arguments.
     *
     * @private
     * @param {Object} object The object to query.
     * @param {Array|string} path The path of the method to invoke.
     * @param {Array} args The arguments to invoke the method with.
     * @returns {*} Returns the result of the invoked method.
     */
    function baseInvoke(object, path, args) {
      path = castPath(path, object);
      object = parent(object, path);
      var func = object == null ? object : object[toKey(last(path))];
      return func == null ? undefined : apply(func, object, args);
    }

    /**
     * The base implementation of `_.isArguments`.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is an `arguments` object,
     */
    function baseIsArguments(value) {
      return isObjectLike(value) && baseGetTag(value) == argsTag;
    }

    /**
     * The base implementation of `_.isArrayBuffer` without Node.js optimizations.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is an array buffer, else `false`.
     */
    function baseIsArrayBuffer(value) {
      return isObjectLike(value) && baseGetTag(value) == arrayBufferTag;
    }

    /**
     * The base implementation of `_.isDate` without Node.js optimizations.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a date object, else `false`.
     */
    function baseIsDate(value) {
      return isObjectLike(value) && baseGetTag(value) == dateTag;
    }

    /**
     * The base implementation of `_.isEqual` which supports partial comparisons
     * and tracks traversed objects.
     *
     * @private
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @param {boolean} bitmask The bitmask flags.
     *  1 - Unordered comparison
     *  2 - Partial comparison
     * @param {Function} [customizer] The function to customize comparisons.
     * @param {Object} [stack] Tracks traversed `value` and `other` objects.
     * @returns {boolean} Returns `true` if the values are equivalent, else `false`.
     */
    function baseIsEqual(value, other, bitmask, customizer, stack) {
      if (value === other) {
        return true;
      }
      if (value == null || other == null || (!isObjectLike(value) && !isObjectLike(other))) {
        return value !== value && other !== other;
      }
      return baseIsEqualDeep(value, other, bitmask, customizer, baseIsEqual, stack);
    }

    /**
     * A specialized version of `baseIsEqual` for arrays and objects which performs
     * deep comparisons and tracks traversed objects enabling objects with circular
     * references to be compared.
     *
     * @private
     * @param {Object} object The object to compare.
     * @param {Object} other The other object to compare.
     * @param {number} bitmask The bitmask flags. See `baseIsEqual` for more details.
     * @param {Function} customizer The function to customize comparisons.
     * @param {Function} equalFunc The function to determine equivalents of values.
     * @param {Object} [stack] Tracks traversed `object` and `other` objects.
     * @returns {boolean} Returns `true` if the objects are equivalent, else `false`.
     */
    function baseIsEqualDeep(object, other, bitmask, customizer, equalFunc, stack) {
      var objIsArr = isArray(object),
          othIsArr = isArray(other),
          objTag = objIsArr ? arrayTag : getTag(object),
          othTag = othIsArr ? arrayTag : getTag(other);

      objTag = objTag == argsTag ? objectTag : objTag;
      othTag = othTag == argsTag ? objectTag : othTag;

      var objIsObj = objTag == objectTag,
          othIsObj = othTag == objectTag,
          isSameTag = objTag == othTag;

      if (isSameTag && isBuffer(object)) {
        if (!isBuffer(other)) {
          return false;
        }
        objIsArr = true;
        objIsObj = false;
      }
      if (isSameTag && !objIsObj) {
        stack || (stack = new Stack);
        return (objIsArr || isTypedArray(object))
          ? equalArrays(object, other, bitmask, customizer, equalFunc, stack)
          : equalByTag(object, other, objTag, bitmask, customizer, equalFunc, stack);
      }
      if (!(bitmask & COMPARE_PARTIAL_FLAG)) {
        var objIsWrapped = objIsObj && hasOwnProperty.call(object, '__wrapped__'),
            othIsWrapped = othIsObj && hasOwnProperty.call(other, '__wrapped__');

        if (objIsWrapped || othIsWrapped) {
          var objUnwrapped = objIsWrapped ? object.value() : object,
              othUnwrapped = othIsWrapped ? other.value() : other;

          stack || (stack = new Stack);
          return equalFunc(objUnwrapped, othUnwrapped, bitmask, customizer, stack);
        }
      }
      if (!isSameTag) {
        return false;
      }
      stack || (stack = new Stack);
      return equalObjects(object, other, bitmask, customizer, equalFunc, stack);
    }

    /**
     * The base implementation of `_.isMap` without Node.js optimizations.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a map, else `false`.
     */
    function baseIsMap(value) {
      return isObjectLike(value) && getTag(value) == mapTag;
    }

    /**
     * The base implementation of `_.isMatch` without support for iteratee shorthands.
     *
     * @private
     * @param {Object} object The object to inspect.
     * @param {Object} source The object of property values to match.
     * @param {Array} matchData The property names, values, and compare flags to match.
     * @param {Function} [customizer] The function to customize comparisons.
     * @returns {boolean} Returns `true` if `object` is a match, else `false`.
     */
    function baseIsMatch(object, source, matchData, customizer) {
      var index = matchData.length,
          length = index,
          noCustomizer = !customizer;

      if (object == null) {
        return !length;
      }
      object = Object(object);
      while (index--) {
        var data = matchData[index];
        if ((noCustomizer && data[2])
              ? data[1] !== object[data[0]]
              : !(data[0] in object)
            ) {
          return false;
        }
      }
      while (++index < length) {
        data = matchData[index];
        var key = data[0],
            objValue = object[key],
            srcValue = data[1];

        if (noCustomizer && data[2]) {
          if (objValue === undefined && !(key in object)) {
            return false;
          }
        } else {
          var stack = new Stack;
          if (customizer) {
            var result = customizer(objValue, srcValue, key, object, source, stack);
          }
          if (!(result === undefined
                ? baseIsEqual(srcValue, objValue, COMPARE_PARTIAL_FLAG | COMPARE_UNORDERED_FLAG, customizer, stack)
                : result
              )) {
            return false;
          }
        }
      }
      return true;
    }

    /**
     * The base implementation of `_.isNative` without bad shim checks.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a native function,
     *  else `false`.
     */
    function baseIsNative(value) {
      if (!isObject(value) || isMasked(value)) {
        return false;
      }
      var pattern = isFunction(value) ? reIsNative : reIsHostCtor;
      return pattern.test(toSource(value));
    }

    /**
     * The base implementation of `_.isRegExp` without Node.js optimizations.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a regexp, else `false`.
     */
    function baseIsRegExp(value) {
      return isObjectLike(value) && baseGetTag(value) == regexpTag;
    }

    /**
     * The base implementation of `_.isSet` without Node.js optimizations.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a set, else `false`.
     */
    function baseIsSet(value) {
      return isObjectLike(value) && getTag(value) == setTag;
    }

    /**
     * The base implementation of `_.isTypedArray` without Node.js optimizations.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a typed array, else `false`.
     */
    function baseIsTypedArray(value) {
      return isObjectLike(value) &&
        isLength(value.length) && !!typedArrayTags[baseGetTag(value)];
    }

    /**
     * The base implementation of `_.iteratee`.
     *
     * @private
     * @param {*} [value=_.identity] The value to convert to an iteratee.
     * @returns {Function} Returns the iteratee.
     */
    function baseIteratee(value) {
      // Don't store the `typeof` result in a variable to avoid a JIT bug in Safari 9.
      // See https://bugs.webkit.org/show_bug.cgi?id=156034 for more details.
      if (typeof value == 'function') {
        return value;
      }
      if (value == null) {
        return identity;
      }
      if (typeof value == 'object') {
        return isArray(value)
          ? baseMatchesProperty(value[0], value[1])
          : baseMatches(value);
      }
      return property(value);
    }

    /**
     * The base implementation of `_.keys` which doesn't treat sparse arrays as dense.
     *
     * @private
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of property names.
     */
    function baseKeys(object) {
      if (!isPrototype(object)) {
        return nativeKeys(object);
      }
      var result = [];
      for (var key in Object(object)) {
        if (hasOwnProperty.call(object, key) && key != 'constructor') {
          result.push(key);
        }
      }
      return result;
    }

    /**
     * The base implementation of `_.keysIn` which doesn't treat sparse arrays as dense.
     *
     * @private
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of property names.
     */
    function baseKeysIn(object) {
      if (!isObject(object)) {
        return nativeKeysIn(object);
      }
      var isProto = isPrototype(object),
          result = [];

      for (var key in object) {
        if (!(key == 'constructor' && (isProto || !hasOwnProperty.call(object, key)))) {
          result.push(key);
        }
      }
      return result;
    }

    /**
     * The base implementation of `_.lt` which doesn't coerce arguments.
     *
     * @private
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @returns {boolean} Returns `true` if `value` is less than `other`,
     *  else `false`.
     */
    function baseLt(value, other) {
      return value < other;
    }

    /**
     * The base implementation of `_.map` without support for iteratee shorthands.
     *
     * @private
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} iteratee The function invoked per iteration.
     * @returns {Array} Returns the new mapped array.
     */
    function baseMap(collection, iteratee) {
      var index = -1,
          result = isArrayLike(collection) ? Array(collection.length) : [];

      baseEach(collection, function(value, key, collection) {
        result[++index] = iteratee(value, key, collection);
      });
      return result;
    }

    /**
     * The base implementation of `_.matches` which doesn't clone `source`.
     *
     * @private
     * @param {Object} source The object of property values to match.
     * @returns {Function} Returns the new spec function.
     */
    function baseMatches(source) {
      var matchData = getMatchData(source);
      if (matchData.length == 1 && matchData[0][2]) {
        return matchesStrictComparable(matchData[0][0], matchData[0][1]);
      }
      return function(object) {
        return object === source || baseIsMatch(object, source, matchData);
      };
    }

    /**
     * The base implementation of `_.matchesProperty` which doesn't clone `srcValue`.
     *
     * @private
     * @param {string} path The path of the property to get.
     * @param {*} srcValue The value to match.
     * @returns {Function} Returns the new spec function.
     */
    function baseMatchesProperty(path, srcValue) {
      if (isKey(path) && isStrictComparable(srcValue)) {
        return matchesStrictComparable(toKey(path), srcValue);
      }
      return function(object) {
        var objValue = get(object, path);
        return (objValue === undefined && objValue === srcValue)
          ? hasIn(object, path)
          : baseIsEqual(srcValue, objValue, COMPARE_PARTIAL_FLAG | COMPARE_UNORDERED_FLAG);
      };
    }

    /**
     * The base implementation of `_.merge` without support for multiple sources.
     *
     * @private
     * @param {Object} object The destination object.
     * @param {Object} source The source object.
     * @param {number} srcIndex The index of `source`.
     * @param {Function} [customizer] The function to customize merged values.
     * @param {Object} [stack] Tracks traversed source values and their merged
     *  counterparts.
     */
    function baseMerge(object, source, srcIndex, customizer, stack) {
      if (object === source) {
        return;
      }
      baseFor(source, function(srcValue, key) {
        if (isObject(srcValue)) {
          stack || (stack = new Stack);
          baseMergeDeep(object, source, key, srcIndex, baseMerge, customizer, stack);
        }
        else {
          var newValue = customizer
            ? customizer(object[key], srcValue, (key + ''), object, source, stack)
            : undefined;

          if (newValue === undefined) {
            newValue = srcValue;
          }
          assignMergeValue(object, key, newValue);
        }
      }, keysIn);
    }

    /**
     * A specialized version of `baseMerge` for arrays and objects which performs
     * deep merges and tracks traversed objects enabling objects with circular
     * references to be merged.
     *
     * @private
     * @param {Object} object The destination object.
     * @param {Object} source The source object.
     * @param {string} key The key of the value to merge.
     * @param {number} srcIndex The index of `source`.
     * @param {Function} mergeFunc The function to merge values.
     * @param {Function} [customizer] The function to customize assigned values.
     * @param {Object} [stack] Tracks traversed source values and their merged
     *  counterparts.
     */
    function baseMergeDeep(object, source, key, srcIndex, mergeFunc, customizer, stack) {
      var objValue = object[key],
          srcValue = source[key],
          stacked = stack.get(srcValue);

      if (stacked) {
        assignMergeValue(object, key, stacked);
        return;
      }
      var newValue = customizer
        ? customizer(objValue, srcValue, (key + ''), object, source, stack)
        : undefined;

      var isCommon = newValue === undefined;

      if (isCommon) {
        var isArr = isArray(srcValue),
            isBuff = !isArr && isBuffer(srcValue),
            isTyped = !isArr && !isBuff && isTypedArray(srcValue);

        newValue = srcValue;
        if (isArr || isBuff || isTyped) {
          if (isArray(objValue)) {
            newValue = objValue;
          }
          else if (isArrayLikeObject(objValue)) {
            newValue = copyArray(objValue);
          }
          else if (isBuff) {
            isCommon = false;
            newValue = cloneBuffer(srcValue, true);
          }
          else if (isTyped) {
            isCommon = false;
            newValue = cloneTypedArray(srcValue, true);
          }
          else {
            newValue = [];
          }
        }
        else if (isPlainObject(srcValue) || isArguments(srcValue)) {
          newValue = objValue;
          if (isArguments(objValue)) {
            newValue = toPlainObject(objValue);
          }
          else if (!isObject(objValue) || (srcIndex && isFunction(objValue))) {
            newValue = initCloneObject(srcValue);
          }
        }
        else {
          isCommon = false;
        }
      }
      if (isCommon) {
        // Recursively merge objects and arrays (susceptible to call stack limits).
        stack.set(srcValue, newValue);
        mergeFunc(newValue, srcValue, srcIndex, customizer, stack);
        stack['delete'](srcValue);
      }
      assignMergeValue(object, key, newValue);
    }

    /**
     * The base implementation of `_.nth` which doesn't coerce arguments.
     *
     * @private
     * @param {Array} array The array to query.
     * @param {number} n The index of the element to return.
     * @returns {*} Returns the nth element of `array`.
     */
    function baseNth(array, n) {
      var length = array.length;
      if (!length) {
        return;
      }
      n += n < 0 ? length : 0;
      return isIndex(n, length) ? array[n] : undefined;
    }

    /**
     * The base implementation of `_.orderBy` without param guards.
     *
     * @private
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function[]|Object[]|string[]} iteratees The iteratees to sort by.
     * @param {string[]} orders The sort orders of `iteratees`.
     * @returns {Array} Returns the new sorted array.
     */
    function baseOrderBy(collection, iteratees, orders) {
      var index = -1;
      iteratees = arrayMap(iteratees.length ? iteratees : [identity], baseUnary(getIteratee()));

      var result = baseMap(collection, function(value, key, collection) {
        var criteria = arrayMap(iteratees, function(iteratee) {
          return iteratee(value);
        });
        return { 'criteria': criteria, 'index': ++index, 'value': value };
      });

      return baseSortBy(result, function(object, other) {
        return compareMultiple(object, other, orders);
      });
    }

    /**
     * The base implementation of `_.pick` without support for individual
     * property identifiers.
     *
     * @private
     * @param {Object} object The source object.
     * @param {string[]} paths The property paths to pick.
     * @returns {Object} Returns the new object.
     */
    function basePick(object, paths) {
      return basePickBy(object, paths, function(value, path) {
        return hasIn(object, path);
      });
    }

    /**
     * The base implementation of  `_.pickBy` without support for iteratee shorthands.
     *
     * @private
     * @param {Object} object The source object.
     * @param {string[]} paths The property paths to pick.
     * @param {Function} predicate The function invoked per property.
     * @returns {Object} Returns the new object.
     */
    function basePickBy(object, paths, predicate) {
      var index = -1,
          length = paths.length,
          result = {};

      while (++index < length) {
        var path = paths[index],
            value = baseGet(object, path);

        if (predicate(value, path)) {
          baseSet(result, castPath(path, object), value);
        }
      }
      return result;
    }

    /**
     * A specialized version of `baseProperty` which supports deep paths.
     *
     * @private
     * @param {Array|string} path The path of the property to get.
     * @returns {Function} Returns the new accessor function.
     */
    function basePropertyDeep(path) {
      return function(object) {
        return baseGet(object, path);
      };
    }

    /**
     * The base implementation of `_.pullAllBy` without support for iteratee
     * shorthands.
     *
     * @private
     * @param {Array} array The array to modify.
     * @param {Array} values The values to remove.
     * @param {Function} [iteratee] The iteratee invoked per element.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns `array`.
     */
    function basePullAll(array, values, iteratee, comparator) {
      var indexOf = comparator ? baseIndexOfWith : baseIndexOf,
          index = -1,
          length = values.length,
          seen = array;

      if (array === values) {
        values = copyArray(values);
      }
      if (iteratee) {
        seen = arrayMap(array, baseUnary(iteratee));
      }
      while (++index < length) {
        var fromIndex = 0,
            value = values[index],
            computed = iteratee ? iteratee(value) : value;

        while ((fromIndex = indexOf(seen, computed, fromIndex, comparator)) > -1) {
          if (seen !== array) {
            splice.call(seen, fromIndex, 1);
          }
          splice.call(array, fromIndex, 1);
        }
      }
      return array;
    }

    /**
     * The base implementation of `_.pullAt` without support for individual
     * indexes or capturing the removed elements.
     *
     * @private
     * @param {Array} array The array to modify.
     * @param {number[]} indexes The indexes of elements to remove.
     * @returns {Array} Returns `array`.
     */
    function basePullAt(array, indexes) {
      var length = array ? indexes.length : 0,
          lastIndex = length - 1;

      while (length--) {
        var index = indexes[length];
        if (length == lastIndex || index !== previous) {
          var previous = index;
          if (isIndex(index)) {
            splice.call(array, index, 1);
          } else {
            baseUnset(array, index);
          }
        }
      }
      return array;
    }

    /**
     * The base implementation of `_.random` without support for returning
     * floating-point numbers.
     *
     * @private
     * @param {number} lower The lower bound.
     * @param {number} upper The upper bound.
     * @returns {number} Returns the random number.
     */
    function baseRandom(lower, upper) {
      return lower + nativeFloor(nativeRandom() * (upper - lower + 1));
    }

    /**
     * The base implementation of `_.range` and `_.rangeRight` which doesn't
     * coerce arguments.
     *
     * @private
     * @param {number} start The start of the range.
     * @param {number} end The end of the range.
     * @param {number} step The value to increment or decrement by.
     * @param {boolean} [fromRight] Specify iterating from right to left.
     * @returns {Array} Returns the range of numbers.
     */
    function baseRange(start, end, step, fromRight) {
      var index = -1,
          length = nativeMax(nativeCeil((end - start) / (step || 1)), 0),
          result = Array(length);

      while (length--) {
        result[fromRight ? length : ++index] = start;
        start += step;
      }
      return result;
    }

    /**
     * The base implementation of `_.repeat` which doesn't coerce arguments.
     *
     * @private
     * @param {string} string The string to repeat.
     * @param {number} n The number of times to repeat the string.
     * @returns {string} Returns the repeated string.
     */
    function baseRepeat(string, n) {
      var result = '';
      if (!string || n < 1 || n > MAX_SAFE_INTEGER) {
        return result;
      }
      // Leverage the exponentiation by squaring algorithm for a faster repeat.
      // See https://en.wikipedia.org/wiki/Exponentiation_by_squaring for more details.
      do {
        if (n % 2) {
          result += string;
        }
        n = nativeFloor(n / 2);
        if (n) {
          string += string;
        }
      } while (n);

      return result;
    }

    /**
     * The base implementation of `_.rest` which doesn't validate or coerce arguments.
     *
     * @private
     * @param {Function} func The function to apply a rest parameter to.
     * @param {number} [start=func.length-1] The start position of the rest parameter.
     * @returns {Function} Returns the new function.
     */
    function baseRest(func, start) {
      return setToString(overRest(func, start, identity), func + '');
    }

    /**
     * The base implementation of `_.sample`.
     *
     * @private
     * @param {Array|Object} collection The collection to sample.
     * @returns {*} Returns the random element.
     */
    function baseSample(collection) {
      return arraySample(values(collection));
    }

    /**
     * The base implementation of `_.sampleSize` without param guards.
     *
     * @private
     * @param {Array|Object} collection The collection to sample.
     * @param {number} n The number of elements to sample.
     * @returns {Array} Returns the random elements.
     */
    function baseSampleSize(collection, n) {
      var array = values(collection);
      return shuffleSelf(array, baseClamp(n, 0, array.length));
    }

    /**
     * The base implementation of `_.set`.
     *
     * @private
     * @param {Object} object The object to modify.
     * @param {Array|string} path The path of the property to set.
     * @param {*} value The value to set.
     * @param {Function} [customizer] The function to customize path creation.
     * @returns {Object} Returns `object`.
     */
    function baseSet(object, path, value, customizer) {
      if (!isObject(object)) {
        return object;
      }
      path = castPath(path, object);

      var index = -1,
          length = path.length,
          lastIndex = length - 1,
          nested = object;

      while (nested != null && ++index < length) {
        var key = toKey(path[index]),
            newValue = value;

        if (index != lastIndex) {
          var objValue = nested[key];
          newValue = customizer ? customizer(objValue, key, nested) : undefined;
          if (newValue === undefined) {
            newValue = isObject(objValue)
              ? objValue
              : (isIndex(path[index + 1]) ? [] : {});
          }
        }
        assignValue(nested, key, newValue);
        nested = nested[key];
      }
      return object;
    }

    /**
     * The base implementation of `setData` without support for hot loop shorting.
     *
     * @private
     * @param {Function} func The function to associate metadata with.
     * @param {*} data The metadata.
     * @returns {Function} Returns `func`.
     */
    var baseSetData = !metaMap ? identity : function(func, data) {
      metaMap.set(func, data);
      return func;
    };

    /**
     * The base implementation of `setToString` without support for hot loop shorting.
     *
     * @private
     * @param {Function} func The function to modify.
     * @param {Function} string The `toString` result.
     * @returns {Function} Returns `func`.
     */
    var baseSetToString = !defineProperty ? identity : function(func, string) {
      return defineProperty(func, 'toString', {
        'configurable': true,
        'enumerable': false,
        'value': constant(string),
        'writable': true
      });
    };

    /**
     * The base implementation of `_.shuffle`.
     *
     * @private
     * @param {Array|Object} collection The collection to shuffle.
     * @returns {Array} Returns the new shuffled array.
     */
    function baseShuffle(collection) {
      return shuffleSelf(values(collection));
    }

    /**
     * The base implementation of `_.slice` without an iteratee call guard.
     *
     * @private
     * @param {Array} array The array to slice.
     * @param {number} [start=0] The start position.
     * @param {number} [end=array.length] The end position.
     * @returns {Array} Returns the slice of `array`.
     */
    function baseSlice(array, start, end) {
      var index = -1,
          length = array.length;

      if (start < 0) {
        start = -start > length ? 0 : (length + start);
      }
      end = end > length ? length : end;
      if (end < 0) {
        end += length;
      }
      length = start > end ? 0 : ((end - start) >>> 0);
      start >>>= 0;

      var result = Array(length);
      while (++index < length) {
        result[index] = array[index + start];
      }
      return result;
    }

    /**
     * The base implementation of `_.some` without support for iteratee shorthands.
     *
     * @private
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} predicate The function invoked per iteration.
     * @returns {boolean} Returns `true` if any element passes the predicate check,
     *  else `false`.
     */
    function baseSome(collection, predicate) {
      var result;

      baseEach(collection, function(value, index, collection) {
        result = predicate(value, index, collection);
        return !result;
      });
      return !!result;
    }

    /**
     * The base implementation of `_.sortedIndex` and `_.sortedLastIndex` which
     * performs a binary search of `array` to determine the index at which `value`
     * should be inserted into `array` in order to maintain its sort order.
     *
     * @private
     * @param {Array} array The sorted array to inspect.
     * @param {*} value The value to evaluate.
     * @param {boolean} [retHighest] Specify returning the highest qualified index.
     * @returns {number} Returns the index at which `value` should be inserted
     *  into `array`.
     */
    function baseSortedIndex(array, value, retHighest) {
      var low = 0,
          high = array == null ? low : array.length;

      if (typeof value == 'number' && value === value && high <= HALF_MAX_ARRAY_LENGTH) {
        while (low < high) {
          var mid = (low + high) >>> 1,
              computed = array[mid];

          if (computed !== null && !isSymbol(computed) &&
              (retHighest ? (computed <= value) : (computed < value))) {
            low = mid + 1;
          } else {
            high = mid;
          }
        }
        return high;
      }
      return baseSortedIndexBy(array, value, identity, retHighest);
    }

    /**
     * The base implementation of `_.sortedIndexBy` and `_.sortedLastIndexBy`
     * which invokes `iteratee` for `value` and each element of `array` to compute
     * their sort ranking. The iteratee is invoked with one argument; (value).
     *
     * @private
     * @param {Array} array The sorted array to inspect.
     * @param {*} value The value to evaluate.
     * @param {Function} iteratee The iteratee invoked per element.
     * @param {boolean} [retHighest] Specify returning the highest qualified index.
     * @returns {number} Returns the index at which `value` should be inserted
     *  into `array`.
     */
    function baseSortedIndexBy(array, value, iteratee, retHighest) {
      value = iteratee(value);

      var low = 0,
          high = array == null ? 0 : array.length,
          valIsNaN = value !== value,
          valIsNull = value === null,
          valIsSymbol = isSymbol(value),
          valIsUndefined = value === undefined;

      while (low < high) {
        var mid = nativeFloor((low + high) / 2),
            computed = iteratee(array[mid]),
            othIsDefined = computed !== undefined,
            othIsNull = computed === null,
            othIsReflexive = computed === computed,
            othIsSymbol = isSymbol(computed);

        if (valIsNaN) {
          var setLow = retHighest || othIsReflexive;
        } else if (valIsUndefined) {
          setLow = othIsReflexive && (retHighest || othIsDefined);
        } else if (valIsNull) {
          setLow = othIsReflexive && othIsDefined && (retHighest || !othIsNull);
        } else if (valIsSymbol) {
          setLow = othIsReflexive && othIsDefined && !othIsNull && (retHighest || !othIsSymbol);
        } else if (othIsNull || othIsSymbol) {
          setLow = false;
        } else {
          setLow = retHighest ? (computed <= value) : (computed < value);
        }
        if (setLow) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      return nativeMin(high, MAX_ARRAY_INDEX);
    }

    /**
     * The base implementation of `_.sortedUniq` and `_.sortedUniqBy` without
     * support for iteratee shorthands.
     *
     * @private
     * @param {Array} array The array to inspect.
     * @param {Function} [iteratee] The iteratee invoked per element.
     * @returns {Array} Returns the new duplicate free array.
     */
    function baseSortedUniq(array, iteratee) {
      var index = -1,
          length = array.length,
          resIndex = 0,
          result = [];

      while (++index < length) {
        var value = array[index],
            computed = iteratee ? iteratee(value) : value;

        if (!index || !eq(computed, seen)) {
          var seen = computed;
          result[resIndex++] = value === 0 ? 0 : value;
        }
      }
      return result;
    }

    /**
     * The base implementation of `_.toNumber` which doesn't ensure correct
     * conversions of binary, hexadecimal, or octal string values.
     *
     * @private
     * @param {*} value The value to process.
     * @returns {number} Returns the number.
     */
    function baseToNumber(value) {
      if (typeof value == 'number') {
        return value;
      }
      if (isSymbol(value)) {
        return NAN;
      }
      return +value;
    }

    /**
     * The base implementation of `_.toString` which doesn't convert nullish
     * values to empty strings.
     *
     * @private
     * @param {*} value The value to process.
     * @returns {string} Returns the string.
     */
    function baseToString(value) {
      // Exit early for strings to avoid a performance hit in some environments.
      if (typeof value == 'string') {
        return value;
      }
      if (isArray(value)) {
        // Recursively convert values (susceptible to call stack limits).
        return arrayMap(value, baseToString) + '';
      }
      if (isSymbol(value)) {
        return symbolToString ? symbolToString.call(value) : '';
      }
      var result = (value + '');
      return (result == '0' && (1 / value) == -INFINITY) ? '-0' : result;
    }

    /**
     * The base implementation of `_.uniqBy` without support for iteratee shorthands.
     *
     * @private
     * @param {Array} array The array to inspect.
     * @param {Function} [iteratee] The iteratee invoked per element.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns the new duplicate free array.
     */
    function baseUniq(array, iteratee, comparator) {
      var index = -1,
          includes = arrayIncludes,
          length = array.length,
          isCommon = true,
          result = [],
          seen = result;

      if (comparator) {
        isCommon = false;
        includes = arrayIncludesWith;
      }
      else if (length >= LARGE_ARRAY_SIZE) {
        var set = iteratee ? null : createSet(array);
        if (set) {
          return setToArray(set);
        }
        isCommon = false;
        includes = cacheHas;
        seen = new SetCache;
      }
      else {
        seen = iteratee ? [] : result;
      }
      outer:
      while (++index < length) {
        var value = array[index],
            computed = iteratee ? iteratee(value) : value;

        value = (comparator || value !== 0) ? value : 0;
        if (isCommon && computed === computed) {
          var seenIndex = seen.length;
          while (seenIndex--) {
            if (seen[seenIndex] === computed) {
              continue outer;
            }
          }
          if (iteratee) {
            seen.push(computed);
          }
          result.push(value);
        }
        else if (!includes(seen, computed, comparator)) {
          if (seen !== result) {
            seen.push(computed);
          }
          result.push(value);
        }
      }
      return result;
    }

    /**
     * The base implementation of `_.unset`.
     *
     * @private
     * @param {Object} object The object to modify.
     * @param {Array|string} path The property path to unset.
     * @returns {boolean} Returns `true` if the property is deleted, else `false`.
     */
    function baseUnset(object, path) {
      path = castPath(path, object);
      object = parent(object, path);
      return object == null || delete object[toKey(last(path))];
    }

    /**
     * The base implementation of `_.update`.
     *
     * @private
     * @param {Object} object The object to modify.
     * @param {Array|string} path The path of the property to update.
     * @param {Function} updater The function to produce the updated value.
     * @param {Function} [customizer] The function to customize path creation.
     * @returns {Object} Returns `object`.
     */
    function baseUpdate(object, path, updater, customizer) {
      return baseSet(object, path, updater(baseGet(object, path)), customizer);
    }

    /**
     * The base implementation of methods like `_.dropWhile` and `_.takeWhile`
     * without support for iteratee shorthands.
     *
     * @private
     * @param {Array} array The array to query.
     * @param {Function} predicate The function invoked per iteration.
     * @param {boolean} [isDrop] Specify dropping elements instead of taking them.
     * @param {boolean} [fromRight] Specify iterating from right to left.
     * @returns {Array} Returns the slice of `array`.
     */
    function baseWhile(array, predicate, isDrop, fromRight) {
      var length = array.length,
          index = fromRight ? length : -1;

      while ((fromRight ? index-- : ++index < length) &&
        predicate(array[index], index, array)) {}

      return isDrop
        ? baseSlice(array, (fromRight ? 0 : index), (fromRight ? index + 1 : length))
        : baseSlice(array, (fromRight ? index + 1 : 0), (fromRight ? length : index));
    }

    /**
     * The base implementation of `wrapperValue` which returns the result of
     * performing a sequence of actions on the unwrapped `value`, where each
     * successive action is supplied the return value of the previous.
     *
     * @private
     * @param {*} value The unwrapped value.
     * @param {Array} actions Actions to perform to resolve the unwrapped value.
     * @returns {*} Returns the resolved value.
     */
    function baseWrapperValue(value, actions) {
      var result = value;
      if (result instanceof LazyWrapper) {
        result = result.value();
      }
      return arrayReduce(actions, function(result, action) {
        return action.func.apply(action.thisArg, arrayPush([result], action.args));
      }, result);
    }

    /**
     * The base implementation of methods like `_.xor`, without support for
     * iteratee shorthands, that accepts an array of arrays to inspect.
     *
     * @private
     * @param {Array} arrays The arrays to inspect.
     * @param {Function} [iteratee] The iteratee invoked per element.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns the new array of values.
     */
    function baseXor(arrays, iteratee, comparator) {
      var length = arrays.length;
      if (length < 2) {
        return length ? baseUniq(arrays[0]) : [];
      }
      var index = -1,
          result = Array(length);

      while (++index < length) {
        var array = arrays[index],
            othIndex = -1;

        while (++othIndex < length) {
          if (othIndex != index) {
            result[index] = baseDifference(result[index] || array, arrays[othIndex], iteratee, comparator);
          }
        }
      }
      return baseUniq(baseFlatten(result, 1), iteratee, comparator);
    }

    /**
     * This base implementation of `_.zipObject` which assigns values using `assignFunc`.
     *
     * @private
     * @param {Array} props The property identifiers.
     * @param {Array} values The property values.
     * @param {Function} assignFunc The function to assign values.
     * @returns {Object} Returns the new object.
     */
    function baseZipObject(props, values, assignFunc) {
      var index = -1,
          length = props.length,
          valsLength = values.length,
          result = {};

      while (++index < length) {
        var value = index < valsLength ? values[index] : undefined;
        assignFunc(result, props[index], value);
      }
      return result;
    }

    /**
     * Casts `value` to an empty array if it's not an array like object.
     *
     * @private
     * @param {*} value The value to inspect.
     * @returns {Array|Object} Returns the cast array-like object.
     */
    function castArrayLikeObject(value) {
      return isArrayLikeObject(value) ? value : [];
    }

    /**
     * Casts `value` to `identity` if it's not a function.
     *
     * @private
     * @param {*} value The value to inspect.
     * @returns {Function} Returns cast function.
     */
    function castFunction(value) {
      return typeof value == 'function' ? value : identity;
    }

    /**
     * Casts `value` to a path array if it's not one.
     *
     * @private
     * @param {*} value The value to inspect.
     * @param {Object} [object] The object to query keys on.
     * @returns {Array} Returns the cast property path array.
     */
    function castPath(value, object) {
      if (isArray(value)) {
        return value;
      }
      return isKey(value, object) ? [value] : stringToPath(toString(value));
    }

    /**
     * A `baseRest` alias which can be replaced with `identity` by module
     * replacement plugins.
     *
     * @private
     * @type {Function}
     * @param {Function} func The function to apply a rest parameter to.
     * @returns {Function} Returns the new function.
     */
    var castRest = baseRest;

    /**
     * Casts `array` to a slice if it's needed.
     *
     * @private
     * @param {Array} array The array to inspect.
     * @param {number} start The start position.
     * @param {number} [end=array.length] The end position.
     * @returns {Array} Returns the cast slice.
     */
    function castSlice(array, start, end) {
      var length = array.length;
      end = end === undefined ? length : end;
      return (!start && end >= length) ? array : baseSlice(array, start, end);
    }

    /**
     * A simple wrapper around the global [`clearTimeout`](https://mdn.io/clearTimeout).
     *
     * @private
     * @param {number|Object} id The timer id or timeout object of the timer to clear.
     */
    var clearTimeout = ctxClearTimeout || function(id) {
      return root.clearTimeout(id);
    };

    /**
     * Creates a clone of  `buffer`.
     *
     * @private
     * @param {Buffer} buffer The buffer to clone.
     * @param {boolean} [isDeep] Specify a deep clone.
     * @returns {Buffer} Returns the cloned buffer.
     */
    function cloneBuffer(buffer, isDeep) {
      if (isDeep) {
        return buffer.slice();
      }
      var length = buffer.length,
          result = allocUnsafe ? allocUnsafe(length) : new buffer.constructor(length);

      buffer.copy(result);
      return result;
    }

    /**
     * Creates a clone of `arrayBuffer`.
     *
     * @private
     * @param {ArrayBuffer} arrayBuffer The array buffer to clone.
     * @returns {ArrayBuffer} Returns the cloned array buffer.
     */
    function cloneArrayBuffer(arrayBuffer) {
      var result = new arrayBuffer.constructor(arrayBuffer.byteLength);
      new Uint8Array(result).set(new Uint8Array(arrayBuffer));
      return result;
    }

    /**
     * Creates a clone of `dataView`.
     *
     * @private
     * @param {Object} dataView The data view to clone.
     * @param {boolean} [isDeep] Specify a deep clone.
     * @returns {Object} Returns the cloned data view.
     */
    function cloneDataView(dataView, isDeep) {
      var buffer = isDeep ? cloneArrayBuffer(dataView.buffer) : dataView.buffer;
      return new dataView.constructor(buffer, dataView.byteOffset, dataView.byteLength);
    }

    /**
     * Creates a clone of `map`.
     *
     * @private
     * @param {Object} map The map to clone.
     * @param {Function} cloneFunc The function to clone values.
     * @param {boolean} [isDeep] Specify a deep clone.
     * @returns {Object} Returns the cloned map.
     */
    function cloneMap(map, isDeep, cloneFunc) {
      var array = isDeep ? cloneFunc(mapToArray(map), CLONE_DEEP_FLAG) : mapToArray(map);
      return arrayReduce(array, addMapEntry, new map.constructor);
    }

    /**
     * Creates a clone of `regexp`.
     *
     * @private
     * @param {Object} regexp The regexp to clone.
     * @returns {Object} Returns the cloned regexp.
     */
    function cloneRegExp(regexp) {
      var result = new regexp.constructor(regexp.source, reFlags.exec(regexp));
      result.lastIndex = regexp.lastIndex;
      return result;
    }

    /**
     * Creates a clone of `set`.
     *
     * @private
     * @param {Object} set The set to clone.
     * @param {Function} cloneFunc The function to clone values.
     * @param {boolean} [isDeep] Specify a deep clone.
     * @returns {Object} Returns the cloned set.
     */
    function cloneSet(set, isDeep, cloneFunc) {
      var array = isDeep ? cloneFunc(setToArray(set), CLONE_DEEP_FLAG) : setToArray(set);
      return arrayReduce(array, addSetEntry, new set.constructor);
    }

    /**
     * Creates a clone of the `symbol` object.
     *
     * @private
     * @param {Object} symbol The symbol object to clone.
     * @returns {Object} Returns the cloned symbol object.
     */
    function cloneSymbol(symbol) {
      return symbolValueOf ? Object(symbolValueOf.call(symbol)) : {};
    }

    /**
     * Creates a clone of `typedArray`.
     *
     * @private
     * @param {Object} typedArray The typed array to clone.
     * @param {boolean} [isDeep] Specify a deep clone.
     * @returns {Object} Returns the cloned typed array.
     */
    function cloneTypedArray(typedArray, isDeep) {
      var buffer = isDeep ? cloneArrayBuffer(typedArray.buffer) : typedArray.buffer;
      return new typedArray.constructor(buffer, typedArray.byteOffset, typedArray.length);
    }

    /**
     * Compares values to sort them in ascending order.
     *
     * @private
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @returns {number} Returns the sort order indicator for `value`.
     */
    function compareAscending(value, other) {
      if (value !== other) {
        var valIsDefined = value !== undefined,
            valIsNull = value === null,
            valIsReflexive = value === value,
            valIsSymbol = isSymbol(value);

        var othIsDefined = other !== undefined,
            othIsNull = other === null,
            othIsReflexive = other === other,
            othIsSymbol = isSymbol(other);

        if ((!othIsNull && !othIsSymbol && !valIsSymbol && value > other) ||
            (valIsSymbol && othIsDefined && othIsReflexive && !othIsNull && !othIsSymbol) ||
            (valIsNull && othIsDefined && othIsReflexive) ||
            (!valIsDefined && othIsReflexive) ||
            !valIsReflexive) {
          return 1;
        }
        if ((!valIsNull && !valIsSymbol && !othIsSymbol && value < other) ||
            (othIsSymbol && valIsDefined && valIsReflexive && !valIsNull && !valIsSymbol) ||
            (othIsNull && valIsDefined && valIsReflexive) ||
            (!othIsDefined && valIsReflexive) ||
            !othIsReflexive) {
          return -1;
        }
      }
      return 0;
    }

    /**
     * Used by `_.orderBy` to compare multiple properties of a value to another
     * and stable sort them.
     *
     * If `orders` is unspecified, all values are sorted in ascending order. Otherwise,
     * specify an order of "desc" for descending or "asc" for ascending sort order
     * of corresponding values.
     *
     * @private
     * @param {Object} object The object to compare.
     * @param {Object} other The other object to compare.
     * @param {boolean[]|string[]} orders The order to sort by for each property.
     * @returns {number} Returns the sort order indicator for `object`.
     */
    function compareMultiple(object, other, orders) {
      var index = -1,
          objCriteria = object.criteria,
          othCriteria = other.criteria,
          length = objCriteria.length,
          ordersLength = orders.length;

      while (++index < length) {
        var result = compareAscending(objCriteria[index], othCriteria[index]);
        if (result) {
          if (index >= ordersLength) {
            return result;
          }
          var order = orders[index];
          return result * (order == 'desc' ? -1 : 1);
        }
      }
      // Fixes an `Array#sort` bug in the JS engine embedded in Adobe applications
      // that causes it, under certain circumstances, to provide the same value for
      // `object` and `other`. See https://github.com/jashkenas/underscore/pull/1247
      // for more details.
      //
      // This also ensures a stable sort in V8 and other engines.
      // See https://bugs.chromium.org/p/v8/issues/detail?id=90 for more details.
      return object.index - other.index;
    }

    /**
     * Creates an array that is the composition of partially applied arguments,
     * placeholders, and provided arguments into a single array of arguments.
     *
     * @private
     * @param {Array} args The provided arguments.
     * @param {Array} partials The arguments to prepend to those provided.
     * @param {Array} holders The `partials` placeholder indexes.
     * @params {boolean} [isCurried] Specify composing for a curried function.
     * @returns {Array} Returns the new array of composed arguments.
     */
    function composeArgs(args, partials, holders, isCurried) {
      var argsIndex = -1,
          argsLength = args.length,
          holdersLength = holders.length,
          leftIndex = -1,
          leftLength = partials.length,
          rangeLength = nativeMax(argsLength - holdersLength, 0),
          result = Array(leftLength + rangeLength),
          isUncurried = !isCurried;

      while (++leftIndex < leftLength) {
        result[leftIndex] = partials[leftIndex];
      }
      while (++argsIndex < holdersLength) {
        if (isUncurried || argsIndex < argsLength) {
          result[holders[argsIndex]] = args[argsIndex];
        }
      }
      while (rangeLength--) {
        result[leftIndex++] = args[argsIndex++];
      }
      return result;
    }

    /**
     * This function is like `composeArgs` except that the arguments composition
     * is tailored for `_.partialRight`.
     *
     * @private
     * @param {Array} args The provided arguments.
     * @param {Array} partials The arguments to append to those provided.
     * @param {Array} holders The `partials` placeholder indexes.
     * @params {boolean} [isCurried] Specify composing for a curried function.
     * @returns {Array} Returns the new array of composed arguments.
     */
    function composeArgsRight(args, partials, holders, isCurried) {
      var argsIndex = -1,
          argsLength = args.length,
          holdersIndex = -1,
          holdersLength = holders.length,
          rightIndex = -1,
          rightLength = partials.length,
          rangeLength = nativeMax(argsLength - holdersLength, 0),
          result = Array(rangeLength + rightLength),
          isUncurried = !isCurried;

      while (++argsIndex < rangeLength) {
        result[argsIndex] = args[argsIndex];
      }
      var offset = argsIndex;
      while (++rightIndex < rightLength) {
        result[offset + rightIndex] = partials[rightIndex];
      }
      while (++holdersIndex < holdersLength) {
        if (isUncurried || argsIndex < argsLength) {
          result[offset + holders[holdersIndex]] = args[argsIndex++];
        }
      }
      return result;
    }

    /**
     * Copies the values of `source` to `array`.
     *
     * @private
     * @param {Array} source The array to copy values from.
     * @param {Array} [array=[]] The array to copy values to.
     * @returns {Array} Returns `array`.
     */
    function copyArray(source, array) {
      var index = -1,
          length = source.length;

      array || (array = Array(length));
      while (++index < length) {
        array[index] = source[index];
      }
      return array;
    }

    /**
     * Copies properties of `source` to `object`.
     *
     * @private
     * @param {Object} source The object to copy properties from.
     * @param {Array} props The property identifiers to copy.
     * @param {Object} [object={}] The object to copy properties to.
     * @param {Function} [customizer] The function to customize copied values.
     * @returns {Object} Returns `object`.
     */
    function copyObject(source, props, object, customizer) {
      var isNew = !object;
      object || (object = {});

      var index = -1,
          length = props.length;

      while (++index < length) {
        var key = props[index];

        var newValue = customizer
          ? customizer(object[key], source[key], key, object, source)
          : undefined;

        if (newValue === undefined) {
          newValue = source[key];
        }
        if (isNew) {
          baseAssignValue(object, key, newValue);
        } else {
          assignValue(object, key, newValue);
        }
      }
      return object;
    }

    /**
     * Copies own symbols of `source` to `object`.
     *
     * @private
     * @param {Object} source The object to copy symbols from.
     * @param {Object} [object={}] The object to copy symbols to.
     * @returns {Object} Returns `object`.
     */
    function copySymbols(source, object) {
      return copyObject(source, getSymbols(source), object);
    }

    /**
     * Copies own and inherited symbols of `source` to `object`.
     *
     * @private
     * @param {Object} source The object to copy symbols from.
     * @param {Object} [object={}] The object to copy symbols to.
     * @returns {Object} Returns `object`.
     */
    function copySymbolsIn(source, object) {
      return copyObject(source, getSymbolsIn(source), object);
    }

    /**
     * Creates a function like `_.groupBy`.
     *
     * @private
     * @param {Function} setter The function to set accumulator values.
     * @param {Function} [initializer] The accumulator object initializer.
     * @returns {Function} Returns the new aggregator function.
     */
    function createAggregator(setter, initializer) {
      return function(collection, iteratee) {
        var func = isArray(collection) ? arrayAggregator : baseAggregator,
            accumulator = initializer ? initializer() : {};

        return func(collection, setter, getIteratee(iteratee, 2), accumulator);
      };
    }

    /**
     * Creates a function like `_.assign`.
     *
     * @private
     * @param {Function} assigner The function to assign values.
     * @returns {Function} Returns the new assigner function.
     */
    function createAssigner(assigner) {
      return baseRest(function(object, sources) {
        var index = -1,
            length = sources.length,
            customizer = length > 1 ? sources[length - 1] : undefined,
            guard = length > 2 ? sources[2] : undefined;

        customizer = (assigner.length > 3 && typeof customizer == 'function')
          ? (length--, customizer)
          : undefined;

        if (guard && isIterateeCall(sources[0], sources[1], guard)) {
          customizer = length < 3 ? undefined : customizer;
          length = 1;
        }
        object = Object(object);
        while (++index < length) {
          var source = sources[index];
          if (source) {
            assigner(object, source, index, customizer);
          }
        }
        return object;
      });
    }

    /**
     * Creates a `baseEach` or `baseEachRight` function.
     *
     * @private
     * @param {Function} eachFunc The function to iterate over a collection.
     * @param {boolean} [fromRight] Specify iterating from right to left.
     * @returns {Function} Returns the new base function.
     */
    function createBaseEach(eachFunc, fromRight) {
      return function(collection, iteratee) {
        if (collection == null) {
          return collection;
        }
        if (!isArrayLike(collection)) {
          return eachFunc(collection, iteratee);
        }
        var length = collection.length,
            index = fromRight ? length : -1,
            iterable = Object(collection);

        while ((fromRight ? index-- : ++index < length)) {
          if (iteratee(iterable[index], index, iterable) === false) {
            break;
          }
        }
        return collection;
      };
    }

    /**
     * Creates a base function for methods like `_.forIn` and `_.forOwn`.
     *
     * @private
     * @param {boolean} [fromRight] Specify iterating from right to left.
     * @returns {Function} Returns the new base function.
     */
    function createBaseFor(fromRight) {
      return function(object, iteratee, keysFunc) {
        var index = -1,
            iterable = Object(object),
            props = keysFunc(object),
            length = props.length;

        while (length--) {
          var key = props[fromRight ? length : ++index];
          if (iteratee(iterable[key], key, iterable) === false) {
            break;
          }
        }
        return object;
      };
    }

    /**
     * Creates a function that wraps `func` to invoke it with the optional `this`
     * binding of `thisArg`.
     *
     * @private
     * @param {Function} func The function to wrap.
     * @param {number} bitmask The bitmask flags. See `createWrap` for more details.
     * @param {*} [thisArg] The `this` binding of `func`.
     * @returns {Function} Returns the new wrapped function.
     */
    function createBind(func, bitmask, thisArg) {
      var isBind = bitmask & WRAP_BIND_FLAG,
          Ctor = createCtor(func);

      function wrapper() {
        var fn = (this && this !== root && this instanceof wrapper) ? Ctor : func;
        return fn.apply(isBind ? thisArg : this, arguments);
      }
      return wrapper;
    }

    /**
     * Creates a function like `_.lowerFirst`.
     *
     * @private
     * @param {string} methodName The name of the `String` case method to use.
     * @returns {Function} Returns the new case function.
     */
    function createCaseFirst(methodName) {
      return function(string) {
        string = toString(string);

        var strSymbols = hasUnicode(string)
          ? stringToArray(string)
          : undefined;

        var chr = strSymbols
          ? strSymbols[0]
          : string.charAt(0);

        var trailing = strSymbols
          ? castSlice(strSymbols, 1).join('')
          : string.slice(1);

        return chr[methodName]() + trailing;
      };
    }

    /**
     * Creates a function like `_.camelCase`.
     *
     * @private
     * @param {Function} callback The function to combine each word.
     * @returns {Function} Returns the new compounder function.
     */
    function createCompounder(callback) {
      return function(string) {
        return arrayReduce(words(deburr(string).replace(reApos, '')), callback, '');
      };
    }

    /**
     * Creates a function that produces an instance of `Ctor` regardless of
     * whether it was invoked as part of a `new` expression or by `call` or `apply`.
     *
     * @private
     * @param {Function} Ctor The constructor to wrap.
     * @returns {Function} Returns the new wrapped function.
     */
    function createCtor(Ctor) {
      return function() {
        // Use a `switch` statement to work with class constructors. See
        // http://ecma-international.org/ecma-262/7.0/#sec-ecmascript-function-objects-call-thisargument-argumentslist
        // for more details.
        var args = arguments;
        switch (args.length) {
          case 0: return new Ctor;
          case 1: return new Ctor(args[0]);
          case 2: return new Ctor(args[0], args[1]);
          case 3: return new Ctor(args[0], args[1], args[2]);
          case 4: return new Ctor(args[0], args[1], args[2], args[3]);
          case 5: return new Ctor(args[0], args[1], args[2], args[3], args[4]);
          case 6: return new Ctor(args[0], args[1], args[2], args[3], args[4], args[5]);
          case 7: return new Ctor(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
        }
        var thisBinding = baseCreate(Ctor.prototype),
            result = Ctor.apply(thisBinding, args);

        // Mimic the constructor's `return` behavior.
        // See https://es5.github.io/#x13.2.2 for more details.
        return isObject(result) ? result : thisBinding;
      };
    }

    /**
     * Creates a function that wraps `func` to enable currying.
     *
     * @private
     * @param {Function} func The function to wrap.
     * @param {number} bitmask The bitmask flags. See `createWrap` for more details.
     * @param {number} arity The arity of `func`.
     * @returns {Function} Returns the new wrapped function.
     */
    function createCurry(func, bitmask, arity) {
      var Ctor = createCtor(func);

      function wrapper() {
        var length = arguments.length,
            args = Array(length),
            index = length,
            placeholder = getHolder(wrapper);

        while (index--) {
          args[index] = arguments[index];
        }
        var holders = (length < 3 && args[0] !== placeholder && args[length - 1] !== placeholder)
          ? []
          : replaceHolders(args, placeholder);

        length -= holders.length;
        if (length < arity) {
          return createRecurry(
            func, bitmask, createHybrid, wrapper.placeholder, undefined,
            args, holders, undefined, undefined, arity - length);
        }
        var fn = (this && this !== root && this instanceof wrapper) ? Ctor : func;
        return apply(fn, this, args);
      }
      return wrapper;
    }

    /**
     * Creates a `_.find` or `_.findLast` function.
     *
     * @private
     * @param {Function} findIndexFunc The function to find the collection index.
     * @returns {Function} Returns the new find function.
     */
    function createFind(findIndexFunc) {
      return function(collection, predicate, fromIndex) {
        var iterable = Object(collection);
        if (!isArrayLike(collection)) {
          var iteratee = getIteratee(predicate, 3);
          collection = keys(collection);
          predicate = function(key) { return iteratee(iterable[key], key, iterable); };
        }
        var index = findIndexFunc(collection, predicate, fromIndex);
        return index > -1 ? iterable[iteratee ? collection[index] : index] : undefined;
      };
    }

    /**
     * Creates a `_.flow` or `_.flowRight` function.
     *
     * @private
     * @param {boolean} [fromRight] Specify iterating from right to left.
     * @returns {Function} Returns the new flow function.
     */
    function createFlow(fromRight) {
      return flatRest(function(funcs) {
        var length = funcs.length,
            index = length,
            prereq = LodashWrapper.prototype.thru;

        if (fromRight) {
          funcs.reverse();
        }
        while (index--) {
          var func = funcs[index];
          if (typeof func != 'function') {
            throw new TypeError(FUNC_ERROR_TEXT);
          }
          if (prereq && !wrapper && getFuncName(func) == 'wrapper') {
            var wrapper = new LodashWrapper([], true);
          }
        }
        index = wrapper ? index : length;
        while (++index < length) {
          func = funcs[index];

          var funcName = getFuncName(func),
              data = funcName == 'wrapper' ? getData(func) : undefined;

          if (data && isLaziable(data[0]) &&
                data[1] == (WRAP_ARY_FLAG | WRAP_CURRY_FLAG | WRAP_PARTIAL_FLAG | WRAP_REARG_FLAG) &&
                !data[4].length && data[9] == 1
              ) {
            wrapper = wrapper[getFuncName(data[0])].apply(wrapper, data[3]);
          } else {
            wrapper = (func.length == 1 && isLaziable(func))
              ? wrapper[funcName]()
              : wrapper.thru(func);
          }
        }
        return function() {
          var args = arguments,
              value = args[0];

          if (wrapper && args.length == 1 && isArray(value)) {
            return wrapper.plant(value).value();
          }
          var index = 0,
              result = length ? funcs[index].apply(this, args) : value;

          while (++index < length) {
            result = funcs[index].call(this, result);
          }
          return result;
        };
      });
    }

    /**
     * Creates a function that wraps `func` to invoke it with optional `this`
     * binding of `thisArg`, partial application, and currying.
     *
     * @private
     * @param {Function|string} func The function or method name to wrap.
     * @param {number} bitmask The bitmask flags. See `createWrap` for more details.
     * @param {*} [thisArg] The `this` binding of `func`.
     * @param {Array} [partials] The arguments to prepend to those provided to
     *  the new function.
     * @param {Array} [holders] The `partials` placeholder indexes.
     * @param {Array} [partialsRight] The arguments to append to those provided
     *  to the new function.
     * @param {Array} [holdersRight] The `partialsRight` placeholder indexes.
     * @param {Array} [argPos] The argument positions of the new function.
     * @param {number} [ary] The arity cap of `func`.
     * @param {number} [arity] The arity of `func`.
     * @returns {Function} Returns the new wrapped function.
     */
    function createHybrid(func, bitmask, thisArg, partials, holders, partialsRight, holdersRight, argPos, ary, arity) {
      var isAry = bitmask & WRAP_ARY_FLAG,
          isBind = bitmask & WRAP_BIND_FLAG,
          isBindKey = bitmask & WRAP_BIND_KEY_FLAG,
          isCurried = bitmask & (WRAP_CURRY_FLAG | WRAP_CURRY_RIGHT_FLAG),
          isFlip = bitmask & WRAP_FLIP_FLAG,
          Ctor = isBindKey ? undefined : createCtor(func);

      function wrapper() {
        var length = arguments.length,
            args = Array(length),
            index = length;

        while (index--) {
          args[index] = arguments[index];
        }
        if (isCurried) {
          var placeholder = getHolder(wrapper),
              holdersCount = countHolders(args, placeholder);
        }
        if (partials) {
          args = composeArgs(args, partials, holders, isCurried);
        }
        if (partialsRight) {
          args = composeArgsRight(args, partialsRight, holdersRight, isCurried);
        }
        length -= holdersCount;
        if (isCurried && length < arity) {
          var newHolders = replaceHolders(args, placeholder);
          return createRecurry(
            func, bitmask, createHybrid, wrapper.placeholder, thisArg,
            args, newHolders, argPos, ary, arity - length
          );
        }
        var thisBinding = isBind ? thisArg : this,
            fn = isBindKey ? thisBinding[func] : func;

        length = args.length;
        if (argPos) {
          args = reorder(args, argPos);
        } else if (isFlip && length > 1) {
          args.reverse();
        }
        if (isAry && ary < length) {
          args.length = ary;
        }
        if (this && this !== root && this instanceof wrapper) {
          fn = Ctor || createCtor(fn);
        }
        return fn.apply(thisBinding, args);
      }
      return wrapper;
    }

    /**
     * Creates a function like `_.invertBy`.
     *
     * @private
     * @param {Function} setter The function to set accumulator values.
     * @param {Function} toIteratee The function to resolve iteratees.
     * @returns {Function} Returns the new inverter function.
     */
    function createInverter(setter, toIteratee) {
      return function(object, iteratee) {
        return baseInverter(object, setter, toIteratee(iteratee), {});
      };
    }

    /**
     * Creates a function that performs a mathematical operation on two values.
     *
     * @private
     * @param {Function} operator The function to perform the operation.
     * @param {number} [defaultValue] The value used for `undefined` arguments.
     * @returns {Function} Returns the new mathematical operation function.
     */
    function createMathOperation(operator, defaultValue) {
      return function(value, other) {
        var result;
        if (value === undefined && other === undefined) {
          return defaultValue;
        }
        if (value !== undefined) {
          result = value;
        }
        if (other !== undefined) {
          if (result === undefined) {
            return other;
          }
          if (typeof value == 'string' || typeof other == 'string') {
            value = baseToString(value);
            other = baseToString(other);
          } else {
            value = baseToNumber(value);
            other = baseToNumber(other);
          }
          result = operator(value, other);
        }
        return result;
      };
    }

    /**
     * Creates a function like `_.over`.
     *
     * @private
     * @param {Function} arrayFunc The function to iterate over iteratees.
     * @returns {Function} Returns the new over function.
     */
    function createOver(arrayFunc) {
      return flatRest(function(iteratees) {
        iteratees = arrayMap(iteratees, baseUnary(getIteratee()));
        return baseRest(function(args) {
          var thisArg = this;
          return arrayFunc(iteratees, function(iteratee) {
            return apply(iteratee, thisArg, args);
          });
        });
      });
    }

    /**
     * Creates the padding for `string` based on `length`. The `chars` string
     * is truncated if the number of characters exceeds `length`.
     *
     * @private
     * @param {number} length The padding length.
     * @param {string} [chars=' '] The string used as padding.
     * @returns {string} Returns the padding for `string`.
     */
    function createPadding(length, chars) {
      chars = chars === undefined ? ' ' : baseToString(chars);

      var charsLength = chars.length;
      if (charsLength < 2) {
        return charsLength ? baseRepeat(chars, length) : chars;
      }
      var result = baseRepeat(chars, nativeCeil(length / stringSize(chars)));
      return hasUnicode(chars)
        ? castSlice(stringToArray(result), 0, length).join('')
        : result.slice(0, length);
    }

    /**
     * Creates a function that wraps `func` to invoke it with the `this` binding
     * of `thisArg` and `partials` prepended to the arguments it receives.
     *
     * @private
     * @param {Function} func The function to wrap.
     * @param {number} bitmask The bitmask flags. See `createWrap` for more details.
     * @param {*} thisArg The `this` binding of `func`.
     * @param {Array} partials The arguments to prepend to those provided to
     *  the new function.
     * @returns {Function} Returns the new wrapped function.
     */
    function createPartial(func, bitmask, thisArg, partials) {
      var isBind = bitmask & WRAP_BIND_FLAG,
          Ctor = createCtor(func);

      function wrapper() {
        var argsIndex = -1,
            argsLength = arguments.length,
            leftIndex = -1,
            leftLength = partials.length,
            args = Array(leftLength + argsLength),
            fn = (this && this !== root && this instanceof wrapper) ? Ctor : func;

        while (++leftIndex < leftLength) {
          args[leftIndex] = partials[leftIndex];
        }
        while (argsLength--) {
          args[leftIndex++] = arguments[++argsIndex];
        }
        return apply(fn, isBind ? thisArg : this, args);
      }
      return wrapper;
    }

    /**
     * Creates a `_.range` or `_.rangeRight` function.
     *
     * @private
     * @param {boolean} [fromRight] Specify iterating from right to left.
     * @returns {Function} Returns the new range function.
     */
    function createRange(fromRight) {
      return function(start, end, step) {
        if (step && typeof step != 'number' && isIterateeCall(start, end, step)) {
          end = step = undefined;
        }
        // Ensure the sign of `-0` is preserved.
        start = toFinite(start);
        if (end === undefined) {
          end = start;
          start = 0;
        } else {
          end = toFinite(end);
        }
        step = step === undefined ? (start < end ? 1 : -1) : toFinite(step);
        return baseRange(start, end, step, fromRight);
      };
    }

    /**
     * Creates a function that performs a relational operation on two values.
     *
     * @private
     * @param {Function} operator The function to perform the operation.
     * @returns {Function} Returns the new relational operation function.
     */
    function createRelationalOperation(operator) {
      return function(value, other) {
        if (!(typeof value == 'string' && typeof other == 'string')) {
          value = toNumber(value);
          other = toNumber(other);
        }
        return operator(value, other);
      };
    }

    /**
     * Creates a function that wraps `func` to continue currying.
     *
     * @private
     * @param {Function} func The function to wrap.
     * @param {number} bitmask The bitmask flags. See `createWrap` for more details.
     * @param {Function} wrapFunc The function to create the `func` wrapper.
     * @param {*} placeholder The placeholder value.
     * @param {*} [thisArg] The `this` binding of `func`.
     * @param {Array} [partials] The arguments to prepend to those provided to
     *  the new function.
     * @param {Array} [holders] The `partials` placeholder indexes.
     * @param {Array} [argPos] The argument positions of the new function.
     * @param {number} [ary] The arity cap of `func`.
     * @param {number} [arity] The arity of `func`.
     * @returns {Function} Returns the new wrapped function.
     */
    function createRecurry(func, bitmask, wrapFunc, placeholder, thisArg, partials, holders, argPos, ary, arity) {
      var isCurry = bitmask & WRAP_CURRY_FLAG,
          newHolders = isCurry ? holders : undefined,
          newHoldersRight = isCurry ? undefined : holders,
          newPartials = isCurry ? partials : undefined,
          newPartialsRight = isCurry ? undefined : partials;

      bitmask |= (isCurry ? WRAP_PARTIAL_FLAG : WRAP_PARTIAL_RIGHT_FLAG);
      bitmask &= ~(isCurry ? WRAP_PARTIAL_RIGHT_FLAG : WRAP_PARTIAL_FLAG);

      if (!(bitmask & WRAP_CURRY_BOUND_FLAG)) {
        bitmask &= ~(WRAP_BIND_FLAG | WRAP_BIND_KEY_FLAG);
      }
      var newData = [
        func, bitmask, thisArg, newPartials, newHolders, newPartialsRight,
        newHoldersRight, argPos, ary, arity
      ];

      var result = wrapFunc.apply(undefined, newData);
      if (isLaziable(func)) {
        setData(result, newData);
      }
      result.placeholder = placeholder;
      return setWrapToString(result, func, bitmask);
    }

    /**
     * Creates a function like `_.round`.
     *
     * @private
     * @param {string} methodName The name of the `Math` method to use when rounding.
     * @returns {Function} Returns the new round function.
     */
    function createRound(methodName) {
      var func = Math[methodName];
      return function(number, precision) {
        number = toNumber(number);
        precision = precision == null ? 0 : nativeMin(toInteger(precision), 292);
        if (precision) {
          // Shift with exponential notation to avoid floating-point issues.
          // See [MDN](https://mdn.io/round#Examples) for more details.
          var pair = (toString(number) + 'e').split('e'),
              value = func(pair[0] + 'e' + (+pair[1] + precision));

          pair = (toString(value) + 'e').split('e');
          return +(pair[0] + 'e' + (+pair[1] - precision));
        }
        return func(number);
      };
    }

    /**
     * Creates a set object of `values`.
     *
     * @private
     * @param {Array} values The values to add to the set.
     * @returns {Object} Returns the new set.
     */
    var createSet = !(Set && (1 / setToArray(new Set([,-0]))[1]) == INFINITY) ? noop : function(values) {
      return new Set(values);
    };

    /**
     * Creates a `_.toPairs` or `_.toPairsIn` function.
     *
     * @private
     * @param {Function} keysFunc The function to get the keys of a given object.
     * @returns {Function} Returns the new pairs function.
     */
    function createToPairs(keysFunc) {
      return function(object) {
        var tag = getTag(object);
        if (tag == mapTag) {
          return mapToArray(object);
        }
        if (tag == setTag) {
          return setToPairs(object);
        }
        return baseToPairs(object, keysFunc(object));
      };
    }

    /**
     * Creates a function that either curries or invokes `func` with optional
     * `this` binding and partially applied arguments.
     *
     * @private
     * @param {Function|string} func The function or method name to wrap.
     * @param {number} bitmask The bitmask flags.
     *    1 - `_.bind`
     *    2 - `_.bindKey`
     *    4 - `_.curry` or `_.curryRight` of a bound function
     *    8 - `_.curry`
     *   16 - `_.curryRight`
     *   32 - `_.partial`
     *   64 - `_.partialRight`
     *  128 - `_.rearg`
     *  256 - `_.ary`
     *  512 - `_.flip`
     * @param {*} [thisArg] The `this` binding of `func`.
     * @param {Array} [partials] The arguments to be partially applied.
     * @param {Array} [holders] The `partials` placeholder indexes.
     * @param {Array} [argPos] The argument positions of the new function.
     * @param {number} [ary] The arity cap of `func`.
     * @param {number} [arity] The arity of `func`.
     * @returns {Function} Returns the new wrapped function.
     */
    function createWrap(func, bitmask, thisArg, partials, holders, argPos, ary, arity) {
      var isBindKey = bitmask & WRAP_BIND_KEY_FLAG;
      if (!isBindKey && typeof func != 'function') {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      var length = partials ? partials.length : 0;
      if (!length) {
        bitmask &= ~(WRAP_PARTIAL_FLAG | WRAP_PARTIAL_RIGHT_FLAG);
        partials = holders = undefined;
      }
      ary = ary === undefined ? ary : nativeMax(toInteger(ary), 0);
      arity = arity === undefined ? arity : toInteger(arity);
      length -= holders ? holders.length : 0;

      if (bitmask & WRAP_PARTIAL_RIGHT_FLAG) {
        var partialsRight = partials,
            holdersRight = holders;

        partials = holders = undefined;
      }
      var data = isBindKey ? undefined : getData(func);

      var newData = [
        func, bitmask, thisArg, partials, holders, partialsRight, holdersRight,
        argPos, ary, arity
      ];

      if (data) {
        mergeData(newData, data);
      }
      func = newData[0];
      bitmask = newData[1];
      thisArg = newData[2];
      partials = newData[3];
      holders = newData[4];
      arity = newData[9] = newData[9] === undefined
        ? (isBindKey ? 0 : func.length)
        : nativeMax(newData[9] - length, 0);

      if (!arity && bitmask & (WRAP_CURRY_FLAG | WRAP_CURRY_RIGHT_FLAG)) {
        bitmask &= ~(WRAP_CURRY_FLAG | WRAP_CURRY_RIGHT_FLAG);
      }
      if (!bitmask || bitmask == WRAP_BIND_FLAG) {
        var result = createBind(func, bitmask, thisArg);
      } else if (bitmask == WRAP_CURRY_FLAG || bitmask == WRAP_CURRY_RIGHT_FLAG) {
        result = createCurry(func, bitmask, arity);
      } else if ((bitmask == WRAP_PARTIAL_FLAG || bitmask == (WRAP_BIND_FLAG | WRAP_PARTIAL_FLAG)) && !holders.length) {
        result = createPartial(func, bitmask, thisArg, partials);
      } else {
        result = createHybrid.apply(undefined, newData);
      }
      var setter = data ? baseSetData : setData;
      return setWrapToString(setter(result, newData), func, bitmask);
    }

    /**
     * Used by `_.defaults` to customize its `_.assignIn` use to assign properties
     * of source objects to the destination object for all destination properties
     * that resolve to `undefined`.
     *
     * @private
     * @param {*} objValue The destination value.
     * @param {*} srcValue The source value.
     * @param {string} key The key of the property to assign.
     * @param {Object} object The parent object of `objValue`.
     * @returns {*} Returns the value to assign.
     */
    function customDefaultsAssignIn(objValue, srcValue, key, object) {
      if (objValue === undefined ||
          (eq(objValue, objectProto[key]) && !hasOwnProperty.call(object, key))) {
        return srcValue;
      }
      return objValue;
    }

    /**
     * Used by `_.defaultsDeep` to customize its `_.merge` use to merge source
     * objects into destination objects that are passed thru.
     *
     * @private
     * @param {*} objValue The destination value.
     * @param {*} srcValue The source value.
     * @param {string} key The key of the property to merge.
     * @param {Object} object The parent object of `objValue`.
     * @param {Object} source The parent object of `srcValue`.
     * @param {Object} [stack] Tracks traversed source values and their merged
     *  counterparts.
     * @returns {*} Returns the value to assign.
     */
    function customDefaultsMerge(objValue, srcValue, key, object, source, stack) {
      if (isObject(objValue) && isObject(srcValue)) {
        // Recursively merge objects and arrays (susceptible to call stack limits).
        stack.set(srcValue, objValue);
        baseMerge(objValue, srcValue, undefined, customDefaultsMerge, stack);
        stack['delete'](srcValue);
      }
      return objValue;
    }

    /**
     * Used by `_.omit` to customize its `_.cloneDeep` use to only clone plain
     * objects.
     *
     * @private
     * @param {*} value The value to inspect.
     * @param {string} key The key of the property to inspect.
     * @returns {*} Returns the uncloned value or `undefined` to defer cloning to `_.cloneDeep`.
     */
    function customOmitClone(value) {
      return isPlainObject(value) ? undefined : value;
    }

    /**
     * A specialized version of `baseIsEqualDeep` for arrays with support for
     * partial deep comparisons.
     *
     * @private
     * @param {Array} array The array to compare.
     * @param {Array} other The other array to compare.
     * @param {number} bitmask The bitmask flags. See `baseIsEqual` for more details.
     * @param {Function} customizer The function to customize comparisons.
     * @param {Function} equalFunc The function to determine equivalents of values.
     * @param {Object} stack Tracks traversed `array` and `other` objects.
     * @returns {boolean} Returns `true` if the arrays are equivalent, else `false`.
     */
    function equalArrays(array, other, bitmask, customizer, equalFunc, stack) {
      var isPartial = bitmask & COMPARE_PARTIAL_FLAG,
          arrLength = array.length,
          othLength = other.length;

      if (arrLength != othLength && !(isPartial && othLength > arrLength)) {
        return false;
      }
      // Assume cyclic values are equal.
      var stacked = stack.get(array);
      if (stacked && stack.get(other)) {
        return stacked == other;
      }
      var index = -1,
          result = true,
          seen = (bitmask & COMPARE_UNORDERED_FLAG) ? new SetCache : undefined;

      stack.set(array, other);
      stack.set(other, array);

      // Ignore non-index properties.
      while (++index < arrLength) {
        var arrValue = array[index],
            othValue = other[index];

        if (customizer) {
          var compared = isPartial
            ? customizer(othValue, arrValue, index, other, array, stack)
            : customizer(arrValue, othValue, index, array, other, stack);
        }
        if (compared !== undefined) {
          if (compared) {
            continue;
          }
          result = false;
          break;
        }
        // Recursively compare arrays (susceptible to call stack limits).
        if (seen) {
          if (!arraySome(other, function(othValue, othIndex) {
                if (!cacheHas(seen, othIndex) &&
                    (arrValue === othValue || equalFunc(arrValue, othValue, bitmask, customizer, stack))) {
                  return seen.push(othIndex);
                }
              })) {
            result = false;
            break;
          }
        } else if (!(
              arrValue === othValue ||
                equalFunc(arrValue, othValue, bitmask, customizer, stack)
            )) {
          result = false;
          break;
        }
      }
      stack['delete'](array);
      stack['delete'](other);
      return result;
    }

    /**
     * A specialized version of `baseIsEqualDeep` for comparing objects of
     * the same `toStringTag`.
     *
     * **Note:** This function only supports comparing values with tags of
     * `Boolean`, `Date`, `Error`, `Number`, `RegExp`, or `String`.
     *
     * @private
     * @param {Object} object The object to compare.
     * @param {Object} other The other object to compare.
     * @param {string} tag The `toStringTag` of the objects to compare.
     * @param {number} bitmask The bitmask flags. See `baseIsEqual` for more details.
     * @param {Function} customizer The function to customize comparisons.
     * @param {Function} equalFunc The function to determine equivalents of values.
     * @param {Object} stack Tracks traversed `object` and `other` objects.
     * @returns {boolean} Returns `true` if the objects are equivalent, else `false`.
     */
    function equalByTag(object, other, tag, bitmask, customizer, equalFunc, stack) {
      switch (tag) {
        case dataViewTag:
          if ((object.byteLength != other.byteLength) ||
              (object.byteOffset != other.byteOffset)) {
            return false;
          }
          object = object.buffer;
          other = other.buffer;

        case arrayBufferTag:
          if ((object.byteLength != other.byteLength) ||
              !equalFunc(new Uint8Array(object), new Uint8Array(other))) {
            return false;
          }
          return true;

        case boolTag:
        case dateTag:
        case numberTag:
          // Coerce booleans to `1` or `0` and dates to milliseconds.
          // Invalid dates are coerced to `NaN`.
          return eq(+object, +other);

        case errorTag:
          return object.name == other.name && object.message == other.message;

        case regexpTag:
        case stringTag:
          // Coerce regexes to strings and treat strings, primitives and objects,
          // as equal. See http://www.ecma-international.org/ecma-262/7.0/#sec-regexp.prototype.tostring
          // for more details.
          return object == (other + '');

        case mapTag:
          var convert = mapToArray;

        case setTag:
          var isPartial = bitmask & COMPARE_PARTIAL_FLAG;
          convert || (convert = setToArray);

          if (object.size != other.size && !isPartial) {
            return false;
          }
          // Assume cyclic values are equal.
          var stacked = stack.get(object);
          if (stacked) {
            return stacked == other;
          }
          bitmask |= COMPARE_UNORDERED_FLAG;

          // Recursively compare objects (susceptible to call stack limits).
          stack.set(object, other);
          var result = equalArrays(convert(object), convert(other), bitmask, customizer, equalFunc, stack);
          stack['delete'](object);
          return result;

        case symbolTag:
          if (symbolValueOf) {
            return symbolValueOf.call(object) == symbolValueOf.call(other);
          }
      }
      return false;
    }

    /**
     * A specialized version of `baseIsEqualDeep` for objects with support for
     * partial deep comparisons.
     *
     * @private
     * @param {Object} object The object to compare.
     * @param {Object} other The other object to compare.
     * @param {number} bitmask The bitmask flags. See `baseIsEqual` for more details.
     * @param {Function} customizer The function to customize comparisons.
     * @param {Function} equalFunc The function to determine equivalents of values.
     * @param {Object} stack Tracks traversed `object` and `other` objects.
     * @returns {boolean} Returns `true` if the objects are equivalent, else `false`.
     */
    function equalObjects(object, other, bitmask, customizer, equalFunc, stack) {
      var isPartial = bitmask & COMPARE_PARTIAL_FLAG,
          objProps = getAllKeys(object),
          objLength = objProps.length,
          othProps = getAllKeys(other),
          othLength = othProps.length;

      if (objLength != othLength && !isPartial) {
        return false;
      }
      var index = objLength;
      while (index--) {
        var key = objProps[index];
        if (!(isPartial ? key in other : hasOwnProperty.call(other, key))) {
          return false;
        }
      }
      // Assume cyclic values are equal.
      var stacked = stack.get(object);
      if (stacked && stack.get(other)) {
        return stacked == other;
      }
      var result = true;
      stack.set(object, other);
      stack.set(other, object);

      var skipCtor = isPartial;
      while (++index < objLength) {
        key = objProps[index];
        var objValue = object[key],
            othValue = other[key];

        if (customizer) {
          var compared = isPartial
            ? customizer(othValue, objValue, key, other, object, stack)
            : customizer(objValue, othValue, key, object, other, stack);
        }
        // Recursively compare objects (susceptible to call stack limits).
        if (!(compared === undefined
              ? (objValue === othValue || equalFunc(objValue, othValue, bitmask, customizer, stack))
              : compared
            )) {
          result = false;
          break;
        }
        skipCtor || (skipCtor = key == 'constructor');
      }
      if (result && !skipCtor) {
        var objCtor = object.constructor,
            othCtor = other.constructor;

        // Non `Object` object instances with different constructors are not equal.
        if (objCtor != othCtor &&
            ('constructor' in object && 'constructor' in other) &&
            !(typeof objCtor == 'function' && objCtor instanceof objCtor &&
              typeof othCtor == 'function' && othCtor instanceof othCtor)) {
          result = false;
        }
      }
      stack['delete'](object);
      stack['delete'](other);
      return result;
    }

    /**
     * A specialized version of `baseRest` which flattens the rest array.
     *
     * @private
     * @param {Function} func The function to apply a rest parameter to.
     * @returns {Function} Returns the new function.
     */
    function flatRest(func) {
      return setToString(overRest(func, undefined, flatten), func + '');
    }

    /**
     * Creates an array of own enumerable property names and symbols of `object`.
     *
     * @private
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of property names and symbols.
     */
    function getAllKeys(object) {
      return baseGetAllKeys(object, keys, getSymbols);
    }

    /**
     * Creates an array of own and inherited enumerable property names and
     * symbols of `object`.
     *
     * @private
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of property names and symbols.
     */
    function getAllKeysIn(object) {
      return baseGetAllKeys(object, keysIn, getSymbolsIn);
    }

    /**
     * Gets metadata for `func`.
     *
     * @private
     * @param {Function} func The function to query.
     * @returns {*} Returns the metadata for `func`.
     */
    var getData = !metaMap ? noop : function(func) {
      return metaMap.get(func);
    };

    /**
     * Gets the name of `func`.
     *
     * @private
     * @param {Function} func The function to query.
     * @returns {string} Returns the function name.
     */
    function getFuncName(func) {
      var result = (func.name + ''),
          array = realNames[result],
          length = hasOwnProperty.call(realNames, result) ? array.length : 0;

      while (length--) {
        var data = array[length],
            otherFunc = data.func;
        if (otherFunc == null || otherFunc == func) {
          return data.name;
        }
      }
      return result;
    }

    /**
     * Gets the argument placeholder value for `func`.
     *
     * @private
     * @param {Function} func The function to inspect.
     * @returns {*} Returns the placeholder value.
     */
    function getHolder(func) {
      var object = hasOwnProperty.call(lodash, 'placeholder') ? lodash : func;
      return object.placeholder;
    }

    /**
     * Gets the appropriate "iteratee" function. If `_.iteratee` is customized,
     * this function returns the custom method, otherwise it returns `baseIteratee`.
     * If arguments are provided, the chosen function is invoked with them and
     * its result is returned.
     *
     * @private
     * @param {*} [value] The value to convert to an iteratee.
     * @param {number} [arity] The arity of the created iteratee.
     * @returns {Function} Returns the chosen function or its result.
     */
    function getIteratee() {
      var result = lodash.iteratee || iteratee;
      result = result === iteratee ? baseIteratee : result;
      return arguments.length ? result(arguments[0], arguments[1]) : result;
    }

    /**
     * Gets the data for `map`.
     *
     * @private
     * @param {Object} map The map to query.
     * @param {string} key The reference key.
     * @returns {*} Returns the map data.
     */
    function getMapData(map, key) {
      var data = map.__data__;
      return isKeyable(key)
        ? data[typeof key == 'string' ? 'string' : 'hash']
        : data.map;
    }

    /**
     * Gets the property names, values, and compare flags of `object`.
     *
     * @private
     * @param {Object} object The object to query.
     * @returns {Array} Returns the match data of `object`.
     */
    function getMatchData(object) {
      var result = keys(object),
          length = result.length;

      while (length--) {
        var key = result[length],
            value = object[key];

        result[length] = [key, value, isStrictComparable(value)];
      }
      return result;
    }

    /**
     * Gets the native function at `key` of `object`.
     *
     * @private
     * @param {Object} object The object to query.
     * @param {string} key The key of the method to get.
     * @returns {*} Returns the function if it's native, else `undefined`.
     */
    function getNative(object, key) {
      var value = getValue(object, key);
      return baseIsNative(value) ? value : undefined;
    }

    /**
     * A specialized version of `baseGetTag` which ignores `Symbol.toStringTag` values.
     *
     * @private
     * @param {*} value The value to query.
     * @returns {string} Returns the raw `toStringTag`.
     */
    function getRawTag(value) {
      var isOwn = hasOwnProperty.call(value, symToStringTag),
          tag = value[symToStringTag];

      try {
        value[symToStringTag] = undefined;
        var unmasked = true;
      } catch (e) {}

      var result = nativeObjectToString.call(value);
      if (unmasked) {
        if (isOwn) {
          value[symToStringTag] = tag;
        } else {
          delete value[symToStringTag];
        }
      }
      return result;
    }

    /**
     * Creates an array of the own enumerable symbols of `object`.
     *
     * @private
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of symbols.
     */
    var getSymbols = !nativeGetSymbols ? stubArray : function(object) {
      if (object == null) {
        return [];
      }
      object = Object(object);
      return arrayFilter(nativeGetSymbols(object), function(symbol) {
        return propertyIsEnumerable.call(object, symbol);
      });
    };

    /**
     * Creates an array of the own and inherited enumerable symbols of `object`.
     *
     * @private
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of symbols.
     */
    var getSymbolsIn = !nativeGetSymbols ? stubArray : function(object) {
      var result = [];
      while (object) {
        arrayPush(result, getSymbols(object));
        object = getPrototype(object);
      }
      return result;
    };

    /**
     * Gets the `toStringTag` of `value`.
     *
     * @private
     * @param {*} value The value to query.
     * @returns {string} Returns the `toStringTag`.
     */
    var getTag = baseGetTag;

    // Fallback for data views, maps, sets, and weak maps in IE 11 and promises in Node.js < 6.
    if ((DataView && getTag(new DataView(new ArrayBuffer(1))) != dataViewTag) ||
        (Map && getTag(new Map) != mapTag) ||
        (Promise && getTag(Promise.resolve()) != promiseTag) ||
        (Set && getTag(new Set) != setTag) ||
        (WeakMap && getTag(new WeakMap) != weakMapTag)) {
      getTag = function(value) {
        var result = baseGetTag(value),
            Ctor = result == objectTag ? value.constructor : undefined,
            ctorString = Ctor ? toSource(Ctor) : '';

        if (ctorString) {
          switch (ctorString) {
            case dataViewCtorString: return dataViewTag;
            case mapCtorString: return mapTag;
            case promiseCtorString: return promiseTag;
            case setCtorString: return setTag;
            case weakMapCtorString: return weakMapTag;
          }
        }
        return result;
      };
    }

    /**
     * Gets the view, applying any `transforms` to the `start` and `end` positions.
     *
     * @private
     * @param {number} start The start of the view.
     * @param {number} end The end of the view.
     * @param {Array} transforms The transformations to apply to the view.
     * @returns {Object} Returns an object containing the `start` and `end`
     *  positions of the view.
     */
    function getView(start, end, transforms) {
      var index = -1,
          length = transforms.length;

      while (++index < length) {
        var data = transforms[index],
            size = data.size;

        switch (data.type) {
          case 'drop':      start += size; break;
          case 'dropRight': end -= size; break;
          case 'take':      end = nativeMin(end, start + size); break;
          case 'takeRight': start = nativeMax(start, end - size); break;
        }
      }
      return { 'start': start, 'end': end };
    }

    /**
     * Extracts wrapper details from the `source` body comment.
     *
     * @private
     * @param {string} source The source to inspect.
     * @returns {Array} Returns the wrapper details.
     */
    function getWrapDetails(source) {
      var match = source.match(reWrapDetails);
      return match ? match[1].split(reSplitDetails) : [];
    }

    /**
     * Checks if `path` exists on `object`.
     *
     * @private
     * @param {Object} object The object to query.
     * @param {Array|string} path The path to check.
     * @param {Function} hasFunc The function to check properties.
     * @returns {boolean} Returns `true` if `path` exists, else `false`.
     */
    function hasPath(object, path, hasFunc) {
      path = castPath(path, object);

      var index = -1,
          length = path.length,
          result = false;

      while (++index < length) {
        var key = toKey(path[index]);
        if (!(result = object != null && hasFunc(object, key))) {
          break;
        }
        object = object[key];
      }
      if (result || ++index != length) {
        return result;
      }
      length = object == null ? 0 : object.length;
      return !!length && isLength(length) && isIndex(key, length) &&
        (isArray(object) || isArguments(object));
    }

    /**
     * Initializes an array clone.
     *
     * @private
     * @param {Array} array The array to clone.
     * @returns {Array} Returns the initialized clone.
     */
    function initCloneArray(array) {
      var length = array.length,
          result = array.constructor(length);

      // Add properties assigned by `RegExp#exec`.
      if (length && typeof array[0] == 'string' && hasOwnProperty.call(array, 'index')) {
        result.index = array.index;
        result.input = array.input;
      }
      return result;
    }

    /**
     * Initializes an object clone.
     *
     * @private
     * @param {Object} object The object to clone.
     * @returns {Object} Returns the initialized clone.
     */
    function initCloneObject(object) {
      return (typeof object.constructor == 'function' && !isPrototype(object))
        ? baseCreate(getPrototype(object))
        : {};
    }

    /**
     * Initializes an object clone based on its `toStringTag`.
     *
     * **Note:** This function only supports cloning values with tags of
     * `Boolean`, `Date`, `Error`, `Number`, `RegExp`, or `String`.
     *
     * @private
     * @param {Object} object The object to clone.
     * @param {string} tag The `toStringTag` of the object to clone.
     * @param {Function} cloneFunc The function to clone values.
     * @param {boolean} [isDeep] Specify a deep clone.
     * @returns {Object} Returns the initialized clone.
     */
    function initCloneByTag(object, tag, cloneFunc, isDeep) {
      var Ctor = object.constructor;
      switch (tag) {
        case arrayBufferTag:
          return cloneArrayBuffer(object);

        case boolTag:
        case dateTag:
          return new Ctor(+object);

        case dataViewTag:
          return cloneDataView(object, isDeep);

        case float32Tag: case float64Tag:
        case int8Tag: case int16Tag: case int32Tag:
        case uint8Tag: case uint8ClampedTag: case uint16Tag: case uint32Tag:
          return cloneTypedArray(object, isDeep);

        case mapTag:
          return cloneMap(object, isDeep, cloneFunc);

        case numberTag:
        case stringTag:
          return new Ctor(object);

        case regexpTag:
          return cloneRegExp(object);

        case setTag:
          return cloneSet(object, isDeep, cloneFunc);

        case symbolTag:
          return cloneSymbol(object);
      }
    }

    /**
     * Inserts wrapper `details` in a comment at the top of the `source` body.
     *
     * @private
     * @param {string} source The source to modify.
     * @returns {Array} details The details to insert.
     * @returns {string} Returns the modified source.
     */
    function insertWrapDetails(source, details) {
      var length = details.length;
      if (!length) {
        return source;
      }
      var lastIndex = length - 1;
      details[lastIndex] = (length > 1 ? '& ' : '') + details[lastIndex];
      details = details.join(length > 2 ? ', ' : ' ');
      return source.replace(reWrapComment, '{\n/* [wrapped with ' + details + '] */\n');
    }

    /**
     * Checks if `value` is a flattenable `arguments` object or array.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is flattenable, else `false`.
     */
    function isFlattenable(value) {
      return isArray(value) || isArguments(value) ||
        !!(spreadableSymbol && value && value[spreadableSymbol]);
    }

    /**
     * Checks if `value` is a valid array-like index.
     *
     * @private
     * @param {*} value The value to check.
     * @param {number} [length=MAX_SAFE_INTEGER] The upper bounds of a valid index.
     * @returns {boolean} Returns `true` if `value` is a valid index, else `false`.
     */
    function isIndex(value, length) {
      length = length == null ? MAX_SAFE_INTEGER : length;
      return !!length &&
        (typeof value == 'number' || reIsUint.test(value)) &&
        (value > -1 && value % 1 == 0 && value < length);
    }

    /**
     * Checks if the given arguments are from an iteratee call.
     *
     * @private
     * @param {*} value The potential iteratee value argument.
     * @param {*} index The potential iteratee index or key argument.
     * @param {*} object The potential iteratee object argument.
     * @returns {boolean} Returns `true` if the arguments are from an iteratee call,
     *  else `false`.
     */
    function isIterateeCall(value, index, object) {
      if (!isObject(object)) {
        return false;
      }
      var type = typeof index;
      if (type == 'number'
            ? (isArrayLike(object) && isIndex(index, object.length))
            : (type == 'string' && index in object)
          ) {
        return eq(object[index], value);
      }
      return false;
    }

    /**
     * Checks if `value` is a property name and not a property path.
     *
     * @private
     * @param {*} value The value to check.
     * @param {Object} [object] The object to query keys on.
     * @returns {boolean} Returns `true` if `value` is a property name, else `false`.
     */
    function isKey(value, object) {
      if (isArray(value)) {
        return false;
      }
      var type = typeof value;
      if (type == 'number' || type == 'symbol' || type == 'boolean' ||
          value == null || isSymbol(value)) {
        return true;
      }
      return reIsPlainProp.test(value) || !reIsDeepProp.test(value) ||
        (object != null && value in Object(object));
    }

    /**
     * Checks if `value` is suitable for use as unique object key.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is suitable, else `false`.
     */
    function isKeyable(value) {
      var type = typeof value;
      return (type == 'string' || type == 'number' || type == 'symbol' || type == 'boolean')
        ? (value !== '__proto__')
        : (value === null);
    }

    /**
     * Checks if `func` has a lazy counterpart.
     *
     * @private
     * @param {Function} func The function to check.
     * @returns {boolean} Returns `true` if `func` has a lazy counterpart,
     *  else `false`.
     */
    function isLaziable(func) {
      var funcName = getFuncName(func),
          other = lodash[funcName];

      if (typeof other != 'function' || !(funcName in LazyWrapper.prototype)) {
        return false;
      }
      if (func === other) {
        return true;
      }
      var data = getData(other);
      return !!data && func === data[0];
    }

    /**
     * Checks if `func` has its source masked.
     *
     * @private
     * @param {Function} func The function to check.
     * @returns {boolean} Returns `true` if `func` is masked, else `false`.
     */
    function isMasked(func) {
      return !!maskSrcKey && (maskSrcKey in func);
    }

    /**
     * Checks if `func` is capable of being masked.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `func` is maskable, else `false`.
     */
    var isMaskable = coreJsData ? isFunction : stubFalse;

    /**
     * Checks if `value` is likely a prototype object.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a prototype, else `false`.
     */
    function isPrototype(value) {
      var Ctor = value && value.constructor,
          proto = (typeof Ctor == 'function' && Ctor.prototype) || objectProto;

      return value === proto;
    }

    /**
     * Checks if `value` is suitable for strict equality comparisons, i.e. `===`.
     *
     * @private
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` if suitable for strict
     *  equality comparisons, else `false`.
     */
    function isStrictComparable(value) {
      return value === value && !isObject(value);
    }

    /**
     * A specialized version of `matchesProperty` for source values suitable
     * for strict equality comparisons, i.e. `===`.
     *
     * @private
     * @param {string} key The key of the property to get.
     * @param {*} srcValue The value to match.
     * @returns {Function} Returns the new spec function.
     */
    function matchesStrictComparable(key, srcValue) {
      return function(object) {
        if (object == null) {
          return false;
        }
        return object[key] === srcValue &&
          (srcValue !== undefined || (key in Object(object)));
      };
    }

    /**
     * A specialized version of `_.memoize` which clears the memoized function's
     * cache when it exceeds `MAX_MEMOIZE_SIZE`.
     *
     * @private
     * @param {Function} func The function to have its output memoized.
     * @returns {Function} Returns the new memoized function.
     */
    function memoizeCapped(func) {
      var result = memoize(func, function(key) {
        if (cache.size === MAX_MEMOIZE_SIZE) {
          cache.clear();
        }
        return key;
      });

      var cache = result.cache;
      return result;
    }

    /**
     * Merges the function metadata of `source` into `data`.
     *
     * Merging metadata reduces the number of wrappers used to invoke a function.
     * This is possible because methods like `_.bind`, `_.curry`, and `_.partial`
     * may be applied regardless of execution order. Methods like `_.ary` and
     * `_.rearg` modify function arguments, making the order in which they are
     * executed important, preventing the merging of metadata. However, we make
     * an exception for a safe combined case where curried functions have `_.ary`
     * and or `_.rearg` applied.
     *
     * @private
     * @param {Array} data The destination metadata.
     * @param {Array} source The source metadata.
     * @returns {Array} Returns `data`.
     */
    function mergeData(data, source) {
      var bitmask = data[1],
          srcBitmask = source[1],
          newBitmask = bitmask | srcBitmask,
          isCommon = newBitmask < (WRAP_BIND_FLAG | WRAP_BIND_KEY_FLAG | WRAP_ARY_FLAG);

      var isCombo =
        ((srcBitmask == WRAP_ARY_FLAG) && (bitmask == WRAP_CURRY_FLAG)) ||
        ((srcBitmask == WRAP_ARY_FLAG) && (bitmask == WRAP_REARG_FLAG) && (data[7].length <= source[8])) ||
        ((srcBitmask == (WRAP_ARY_FLAG | WRAP_REARG_FLAG)) && (source[7].length <= source[8]) && (bitmask == WRAP_CURRY_FLAG));

      // Exit early if metadata can't be merged.
      if (!(isCommon || isCombo)) {
        return data;
      }
      // Use source `thisArg` if available.
      if (srcBitmask & WRAP_BIND_FLAG) {
        data[2] = source[2];
        // Set when currying a bound function.
        newBitmask |= bitmask & WRAP_BIND_FLAG ? 0 : WRAP_CURRY_BOUND_FLAG;
      }
      // Compose partial arguments.
      var value = source[3];
      if (value) {
        var partials = data[3];
        data[3] = partials ? composeArgs(partials, value, source[4]) : value;
        data[4] = partials ? replaceHolders(data[3], PLACEHOLDER) : source[4];
      }
      // Compose partial right arguments.
      value = source[5];
      if (value) {
        partials = data[5];
        data[5] = partials ? composeArgsRight(partials, value, source[6]) : value;
        data[6] = partials ? replaceHolders(data[5], PLACEHOLDER) : source[6];
      }
      // Use source `argPos` if available.
      value = source[7];
      if (value) {
        data[7] = value;
      }
      // Use source `ary` if it's smaller.
      if (srcBitmask & WRAP_ARY_FLAG) {
        data[8] = data[8] == null ? source[8] : nativeMin(data[8], source[8]);
      }
      // Use source `arity` if one is not provided.
      if (data[9] == null) {
        data[9] = source[9];
      }
      // Use source `func` and merge bitmasks.
      data[0] = source[0];
      data[1] = newBitmask;

      return data;
    }

    /**
     * This function is like
     * [`Object.keys`](http://ecma-international.org/ecma-262/7.0/#sec-object.keys)
     * except that it includes inherited enumerable properties.
     *
     * @private
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of property names.
     */
    function nativeKeysIn(object) {
      var result = [];
      if (object != null) {
        for (var key in Object(object)) {
          result.push(key);
        }
      }
      return result;
    }

    /**
     * Converts `value` to a string using `Object.prototype.toString`.
     *
     * @private
     * @param {*} value The value to convert.
     * @returns {string} Returns the converted string.
     */
    function objectToString(value) {
      return nativeObjectToString.call(value);
    }

    /**
     * A specialized version of `baseRest` which transforms the rest array.
     *
     * @private
     * @param {Function} func The function to apply a rest parameter to.
     * @param {number} [start=func.length-1] The start position of the rest parameter.
     * @param {Function} transform The rest array transform.
     * @returns {Function} Returns the new function.
     */
    function overRest(func, start, transform) {
      start = nativeMax(start === undefined ? (func.length - 1) : start, 0);
      return function() {
        var args = arguments,
            index = -1,
            length = nativeMax(args.length - start, 0),
            array = Array(length);

        while (++index < length) {
          array[index] = args[start + index];
        }
        index = -1;
        var otherArgs = Array(start + 1);
        while (++index < start) {
          otherArgs[index] = args[index];
        }
        otherArgs[start] = transform(array);
        return apply(func, this, otherArgs);
      };
    }

    /**
     * Gets the parent value at `path` of `object`.
     *
     * @private
     * @param {Object} object The object to query.
     * @param {Array} path The path to get the parent value of.
     * @returns {*} Returns the parent value.
     */
    function parent(object, path) {
      return path.length < 2 ? object : baseGet(object, baseSlice(path, 0, -1));
    }

    /**
     * Reorder `array` according to the specified indexes where the element at
     * the first index is assigned as the first element, the element at
     * the second index is assigned as the second element, and so on.
     *
     * @private
     * @param {Array} array The array to reorder.
     * @param {Array} indexes The arranged array indexes.
     * @returns {Array} Returns `array`.
     */
    function reorder(array, indexes) {
      var arrLength = array.length,
          length = nativeMin(indexes.length, arrLength),
          oldArray = copyArray(array);

      while (length--) {
        var index = indexes[length];
        array[length] = isIndex(index, arrLength) ? oldArray[index] : undefined;
      }
      return array;
    }

    /**
     * Sets metadata for `func`.
     *
     * **Note:** If this function becomes hot, i.e. is invoked a lot in a short
     * period of time, it will trip its breaker and transition to an identity
     * function to avoid garbage collection pauses in V8. See
     * [V8 issue 2070](https://bugs.chromium.org/p/v8/issues/detail?id=2070)
     * for more details.
     *
     * @private
     * @param {Function} func The function to associate metadata with.
     * @param {*} data The metadata.
     * @returns {Function} Returns `func`.
     */
    var setData = shortOut(baseSetData);

    /**
     * A simple wrapper around the global [`setTimeout`](https://mdn.io/setTimeout).
     *
     * @private
     * @param {Function} func The function to delay.
     * @param {number} wait The number of milliseconds to delay invocation.
     * @returns {number|Object} Returns the timer id or timeout object.
     */
    var setTimeout = ctxSetTimeout || function(func, wait) {
      return root.setTimeout(func, wait);
    };

    /**
     * Sets the `toString` method of `func` to return `string`.
     *
     * @private
     * @param {Function} func The function to modify.
     * @param {Function} string The `toString` result.
     * @returns {Function} Returns `func`.
     */
    var setToString = shortOut(baseSetToString);

    /**
     * Sets the `toString` method of `wrapper` to mimic the source of `reference`
     * with wrapper details in a comment at the top of the source body.
     *
     * @private
     * @param {Function} wrapper The function to modify.
     * @param {Function} reference The reference function.
     * @param {number} bitmask The bitmask flags. See `createWrap` for more details.
     * @returns {Function} Returns `wrapper`.
     */
    function setWrapToString(wrapper, reference, bitmask) {
      var source = (reference + '');
      return setToString(wrapper, insertWrapDetails(source, updateWrapDetails(getWrapDetails(source), bitmask)));
    }

    /**
     * Creates a function that'll short out and invoke `identity` instead
     * of `func` when it's called `HOT_COUNT` or more times in `HOT_SPAN`
     * milliseconds.
     *
     * @private
     * @param {Function} func The function to restrict.
     * @returns {Function} Returns the new shortable function.
     */
    function shortOut(func) {
      var count = 0,
          lastCalled = 0;

      return function() {
        var stamp = nativeNow(),
            remaining = HOT_SPAN - (stamp - lastCalled);

        lastCalled = stamp;
        if (remaining > 0) {
          if (++count >= HOT_COUNT) {
            return arguments[0];
          }
        } else {
          count = 0;
        }
        return func.apply(undefined, arguments);
      };
    }

    /**
     * A specialized version of `_.shuffle` which mutates and sets the size of `array`.
     *
     * @private
     * @param {Array} array The array to shuffle.
     * @param {number} [size=array.length] The size of `array`.
     * @returns {Array} Returns `array`.
     */
    function shuffleSelf(array, size) {
      var index = -1,
          length = array.length,
          lastIndex = length - 1;

      size = size === undefined ? length : size;
      while (++index < size) {
        var rand = baseRandom(index, lastIndex),
            value = array[rand];

        array[rand] = array[index];
        array[index] = value;
      }
      array.length = size;
      return array;
    }

    /**
     * Converts `string` to a property path array.
     *
     * @private
     * @param {string} string The string to convert.
     * @returns {Array} Returns the property path array.
     */
    var stringToPath = memoizeCapped(function(string) {
      var result = [];
      if (reLeadingDot.test(string)) {
        result.push('');
      }
      string.replace(rePropName, function(match, number, quote, string) {
        result.push(quote ? string.replace(reEscapeChar, '$1') : (number || match));
      });
      return result;
    });

    /**
     * Converts `value` to a string key if it's not a string or symbol.
     *
     * @private
     * @param {*} value The value to inspect.
     * @returns {string|symbol} Returns the key.
     */
    function toKey(value) {
      if (typeof value == 'string' || isSymbol(value)) {
        return value;
      }
      var result = (value + '');
      return (result == '0' && (1 / value) == -INFINITY) ? '-0' : result;
    }

    /**
     * Converts `func` to its source code.
     *
     * @private
     * @param {Function} func The function to convert.
     * @returns {string} Returns the source code.
     */
    function toSource(func) {
      if (func != null) {
        try {
          return funcToString.call(func);
        } catch (e) {}
        try {
          return (func + '');
        } catch (e) {}
      }
      return '';
    }

    /**
     * Updates wrapper `details` based on `bitmask` flags.
     *
     * @private
     * @returns {Array} details The details to modify.
     * @param {number} bitmask The bitmask flags. See `createWrap` for more details.
     * @returns {Array} Returns `details`.
     */
    function updateWrapDetails(details, bitmask) {
      arrayEach(wrapFlags, function(pair) {
        var value = '_.' + pair[0];
        if ((bitmask & pair[1]) && !arrayIncludes(details, value)) {
          details.push(value);
        }
      });
      return details.sort();
    }

    /**
     * Creates a clone of `wrapper`.
     *
     * @private
     * @param {Object} wrapper The wrapper to clone.
     * @returns {Object} Returns the cloned wrapper.
     */
    function wrapperClone(wrapper) {
      if (wrapper instanceof LazyWrapper) {
        return wrapper.clone();
      }
      var result = new LodashWrapper(wrapper.__wrapped__, wrapper.__chain__);
      result.__actions__ = copyArray(wrapper.__actions__);
      result.__index__  = wrapper.__index__;
      result.__values__ = wrapper.__values__;
      return result;
    }

    /*------------------------------------------------------------------------*/

    /**
     * Creates an array of elements split into groups the length of `size`.
     * If `array` can't be split evenly, the final chunk will be the remaining
     * elements.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The array to process.
     * @param {number} [size=1] The length of each chunk
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Array} Returns the new array of chunks.
     * @example
     *
     * _.chunk(['a', 'b', 'c', 'd'], 2);
     * // => [['a', 'b'], ['c', 'd']]
     *
     * _.chunk(['a', 'b', 'c', 'd'], 3);
     * // => [['a', 'b', 'c'], ['d']]
     */
    function chunk(array, size, guard) {
      if ((guard ? isIterateeCall(array, size, guard) : size === undefined)) {
        size = 1;
      } else {
        size = nativeMax(toInteger(size), 0);
      }
      var length = array == null ? 0 : array.length;
      if (!length || size < 1) {
        return [];
      }
      var index = 0,
          resIndex = 0,
          result = Array(nativeCeil(length / size));

      while (index < length) {
        result[resIndex++] = baseSlice(array, index, (index += size));
      }
      return result;
    }

    /**
     * Creates an array with all falsey values removed. The values `false`, `null`,
     * `0`, `""`, `undefined`, and `NaN` are falsey.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The array to compact.
     * @returns {Array} Returns the new array of filtered values.
     * @example
     *
     * _.compact([0, 1, false, 2, '', 3]);
     * // => [1, 2, 3]
     */
    function compact(array) {
      var index = -1,
          length = array == null ? 0 : array.length,
          resIndex = 0,
          result = [];

      while (++index < length) {
        var value = array[index];
        if (value) {
          result[resIndex++] = value;
        }
      }
      return result;
    }

    /**
     * Creates a new array concatenating `array` with any additional arrays
     * and/or values.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to concatenate.
     * @param {...*} [values] The values to concatenate.
     * @returns {Array} Returns the new concatenated array.
     * @example
     *
     * var array = [1];
     * var other = _.concat(array, 2, [3], [[4]]);
     *
     * console.log(other);
     * // => [1, 2, 3, [4]]
     *
     * console.log(array);
     * // => [1]
     */
    function concat() {
      var length = arguments.length;
      if (!length) {
        return [];
      }
      var args = Array(length - 1),
          array = arguments[0],
          index = length;

      while (index--) {
        args[index - 1] = arguments[index];
      }
      return arrayPush(isArray(array) ? copyArray(array) : [array], baseFlatten(args, 1));
    }

    /**
     * Creates an array of `array` values not included in the other given arrays
     * using [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
     * for equality comparisons. The order and references of result values are
     * determined by the first array.
     *
     * **Note:** Unlike `_.pullAll`, this method returns a new array.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {...Array} [values] The values to exclude.
     * @returns {Array} Returns the new array of filtered values.
     * @see _.without, _.xor
     * @example
     *
     * _.difference([2, 1], [2, 3]);
     * // => [1]
     */
    var difference = baseRest(function(array, values) {
      return isArrayLikeObject(array)
        ? baseDifference(array, baseFlatten(values, 1, isArrayLikeObject, true))
        : [];
    });

    /**
     * This method is like `_.difference` except that it accepts `iteratee` which
     * is invoked for each element of `array` and `values` to generate the criterion
     * by which they're compared. The order and references of result values are
     * determined by the first array. The iteratee is invoked with one argument:
     * (value).
     *
     * **Note:** Unlike `_.pullAllBy`, this method returns a new array.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {...Array} [values] The values to exclude.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {Array} Returns the new array of filtered values.
     * @example
     *
     * _.differenceBy([2.1, 1.2], [2.3, 3.4], Math.floor);
     * // => [1.2]
     *
     * // The `_.property` iteratee shorthand.
     * _.differenceBy([{ 'x': 2 }, { 'x': 1 }], [{ 'x': 1 }], 'x');
     * // => [{ 'x': 2 }]
     */
    var differenceBy = baseRest(function(array, values) {
      var iteratee = last(values);
      if (isArrayLikeObject(iteratee)) {
        iteratee = undefined;
      }
      return isArrayLikeObject(array)
        ? baseDifference(array, baseFlatten(values, 1, isArrayLikeObject, true), getIteratee(iteratee, 2))
        : [];
    });

    /**
     * This method is like `_.difference` except that it accepts `comparator`
     * which is invoked to compare elements of `array` to `values`. The order and
     * references of result values are determined by the first array. The comparator
     * is invoked with two arguments: (arrVal, othVal).
     *
     * **Note:** Unlike `_.pullAllWith`, this method returns a new array.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {...Array} [values] The values to exclude.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns the new array of filtered values.
     * @example
     *
     * var objects = [{ 'x': 1, 'y': 2 }, { 'x': 2, 'y': 1 }];
     *
     * _.differenceWith(objects, [{ 'x': 1, 'y': 2 }], _.isEqual);
     * // => [{ 'x': 2, 'y': 1 }]
     */
    var differenceWith = baseRest(function(array, values) {
      var comparator = last(values);
      if (isArrayLikeObject(comparator)) {
        comparator = undefined;
      }
      return isArrayLikeObject(array)
        ? baseDifference(array, baseFlatten(values, 1, isArrayLikeObject, true), undefined, comparator)
        : [];
    });

    /**
     * Creates a slice of `array` with `n` elements dropped from the beginning.
     *
     * @static
     * @memberOf _
     * @since 0.5.0
     * @category Array
     * @param {Array} array The array to query.
     * @param {number} [n=1] The number of elements to drop.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Array} Returns the slice of `array`.
     * @example
     *
     * _.drop([1, 2, 3]);
     * // => [2, 3]
     *
     * _.drop([1, 2, 3], 2);
     * // => [3]
     *
     * _.drop([1, 2, 3], 5);
     * // => []
     *
     * _.drop([1, 2, 3], 0);
     * // => [1, 2, 3]
     */
    function drop(array, n, guard) {
      var length = array == null ? 0 : array.length;
      if (!length) {
        return [];
      }
      n = (guard || n === undefined) ? 1 : toInteger(n);
      return baseSlice(array, n < 0 ? 0 : n, length);
    }

    /**
     * Creates a slice of `array` with `n` elements dropped from the end.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The array to query.
     * @param {number} [n=1] The number of elements to drop.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Array} Returns the slice of `array`.
     * @example
     *
     * _.dropRight([1, 2, 3]);
     * // => [1, 2]
     *
     * _.dropRight([1, 2, 3], 2);
     * // => [1]
     *
     * _.dropRight([1, 2, 3], 5);
     * // => []
     *
     * _.dropRight([1, 2, 3], 0);
     * // => [1, 2, 3]
     */
    function dropRight(array, n, guard) {
      var length = array == null ? 0 : array.length;
      if (!length) {
        return [];
      }
      n = (guard || n === undefined) ? 1 : toInteger(n);
      n = length - n;
      return baseSlice(array, 0, n < 0 ? 0 : n);
    }

    /**
     * Creates a slice of `array` excluding elements dropped from the end.
     * Elements are dropped until `predicate` returns falsey. The predicate is
     * invoked with three arguments: (value, index, array).
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The array to query.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the slice of `array`.
     * @example
     *
     * var users = [
     *   { 'user': 'barney',  'active': true },
     *   { 'user': 'fred',    'active': false },
     *   { 'user': 'pebbles', 'active': false }
     * ];
     *
     * _.dropRightWhile(users, function(o) { return !o.active; });
     * // => objects for ['barney']
     *
     * // The `_.matches` iteratee shorthand.
     * _.dropRightWhile(users, { 'user': 'pebbles', 'active': false });
     * // => objects for ['barney', 'fred']
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.dropRightWhile(users, ['active', false]);
     * // => objects for ['barney']
     *
     * // The `_.property` iteratee shorthand.
     * _.dropRightWhile(users, 'active');
     * // => objects for ['barney', 'fred', 'pebbles']
     */
    function dropRightWhile(array, predicate) {
      return (array && array.length)
        ? baseWhile(array, getIteratee(predicate, 3), true, true)
        : [];
    }

    /**
     * Creates a slice of `array` excluding elements dropped from the beginning.
     * Elements are dropped until `predicate` returns falsey. The predicate is
     * invoked with three arguments: (value, index, array).
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The array to query.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the slice of `array`.
     * @example
     *
     * var users = [
     *   { 'user': 'barney',  'active': false },
     *   { 'user': 'fred',    'active': false },
     *   { 'user': 'pebbles', 'active': true }
     * ];
     *
     * _.dropWhile(users, function(o) { return !o.active; });
     * // => objects for ['pebbles']
     *
     * // The `_.matches` iteratee shorthand.
     * _.dropWhile(users, { 'user': 'barney', 'active': false });
     * // => objects for ['fred', 'pebbles']
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.dropWhile(users, ['active', false]);
     * // => objects for ['pebbles']
     *
     * // The `_.property` iteratee shorthand.
     * _.dropWhile(users, 'active');
     * // => objects for ['barney', 'fred', 'pebbles']
     */
    function dropWhile(array, predicate) {
      return (array && array.length)
        ? baseWhile(array, getIteratee(predicate, 3), true)
        : [];
    }

    /**
     * Fills elements of `array` with `value` from `start` up to, but not
     * including, `end`.
     *
     * **Note:** This method mutates `array`.
     *
     * @static
     * @memberOf _
     * @since 3.2.0
     * @category Array
     * @param {Array} array The array to fill.
     * @param {*} value The value to fill `array` with.
     * @param {number} [start=0] The start position.
     * @param {number} [end=array.length] The end position.
     * @returns {Array} Returns `array`.
     * @example
     *
     * var array = [1, 2, 3];
     *
     * _.fill(array, 'a');
     * console.log(array);
     * // => ['a', 'a', 'a']
     *
     * _.fill(Array(3), 2);
     * // => [2, 2, 2]
     *
     * _.fill([4, 6, 8, 10], '*', 1, 3);
     * // => [4, '*', '*', 10]
     */
    function fill(array, value, start, end) {
      var length = array == null ? 0 : array.length;
      if (!length) {
        return [];
      }
      if (start && typeof start != 'number' && isIterateeCall(array, value, start)) {
        start = 0;
        end = length;
      }
      return baseFill(array, value, start, end);
    }

    /**
     * This method is like `_.find` except that it returns the index of the first
     * element `predicate` returns truthy for instead of the element itself.
     *
     * @static
     * @memberOf _
     * @since 1.1.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @param {number} [fromIndex=0] The index to search from.
     * @returns {number} Returns the index of the found element, else `-1`.
     * @example
     *
     * var users = [
     *   { 'user': 'barney',  'active': false },
     *   { 'user': 'fred',    'active': false },
     *   { 'user': 'pebbles', 'active': true }
     * ];
     *
     * _.findIndex(users, function(o) { return o.user == 'barney'; });
     * // => 0
     *
     * // The `_.matches` iteratee shorthand.
     * _.findIndex(users, { 'user': 'fred', 'active': false });
     * // => 1
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.findIndex(users, ['active', false]);
     * // => 0
     *
     * // The `_.property` iteratee shorthand.
     * _.findIndex(users, 'active');
     * // => 2
     */
    function findIndex(array, predicate, fromIndex) {
      var length = array == null ? 0 : array.length;
      if (!length) {
        return -1;
      }
      var index = fromIndex == null ? 0 : toInteger(fromIndex);
      if (index < 0) {
        index = nativeMax(length + index, 0);
      }
      return baseFindIndex(array, getIteratee(predicate, 3), index);
    }

    /**
     * This method is like `_.findIndex` except that it iterates over elements
     * of `collection` from right to left.
     *
     * @static
     * @memberOf _
     * @since 2.0.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @param {number} [fromIndex=array.length-1] The index to search from.
     * @returns {number} Returns the index of the found element, else `-1`.
     * @example
     *
     * var users = [
     *   { 'user': 'barney',  'active': true },
     *   { 'user': 'fred',    'active': false },
     *   { 'user': 'pebbles', 'active': false }
     * ];
     *
     * _.findLastIndex(users, function(o) { return o.user == 'pebbles'; });
     * // => 2
     *
     * // The `_.matches` iteratee shorthand.
     * _.findLastIndex(users, { 'user': 'barney', 'active': true });
     * // => 0
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.findLastIndex(users, ['active', false]);
     * // => 2
     *
     * // The `_.property` iteratee shorthand.
     * _.findLastIndex(users, 'active');
     * // => 0
     */
    function findLastIndex(array, predicate, fromIndex) {
      var length = array == null ? 0 : array.length;
      if (!length) {
        return -1;
      }
      var index = length - 1;
      if (fromIndex !== undefined) {
        index = toInteger(fromIndex);
        index = fromIndex < 0
          ? nativeMax(length + index, 0)
          : nativeMin(index, length - 1);
      }
      return baseFindIndex(array, getIteratee(predicate, 3), index, true);
    }

    /**
     * Flattens `array` a single level deep.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The array to flatten.
     * @returns {Array} Returns the new flattened array.
     * @example
     *
     * _.flatten([1, [2, [3, [4]], 5]]);
     * // => [1, 2, [3, [4]], 5]
     */
    function flatten(array) {
      var length = array == null ? 0 : array.length;
      return length ? baseFlatten(array, 1) : [];
    }

    /**
     * Recursively flattens `array`.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The array to flatten.
     * @returns {Array} Returns the new flattened array.
     * @example
     *
     * _.flattenDeep([1, [2, [3, [4]], 5]]);
     * // => [1, 2, 3, 4, 5]
     */
    function flattenDeep(array) {
      var length = array == null ? 0 : array.length;
      return length ? baseFlatten(array, INFINITY) : [];
    }

    /**
     * Recursively flatten `array` up to `depth` times.
     *
     * @static
     * @memberOf _
     * @since 4.4.0
     * @category Array
     * @param {Array} array The array to flatten.
     * @param {number} [depth=1] The maximum recursion depth.
     * @returns {Array} Returns the new flattened array.
     * @example
     *
     * var array = [1, [2, [3, [4]], 5]];
     *
     * _.flattenDepth(array, 1);
     * // => [1, 2, [3, [4]], 5]
     *
     * _.flattenDepth(array, 2);
     * // => [1, 2, 3, [4], 5]
     */
    function flattenDepth(array, depth) {
      var length = array == null ? 0 : array.length;
      if (!length) {
        return [];
      }
      depth = depth === undefined ? 1 : toInteger(depth);
      return baseFlatten(array, depth);
    }

    /**
     * The inverse of `_.toPairs`; this method returns an object composed
     * from key-value `pairs`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} pairs The key-value pairs.
     * @returns {Object} Returns the new object.
     * @example
     *
     * _.fromPairs([['a', 1], ['b', 2]]);
     * // => { 'a': 1, 'b': 2 }
     */
    function fromPairs(pairs) {
      var index = -1,
          length = pairs == null ? 0 : pairs.length,
          result = {};

      while (++index < length) {
        var pair = pairs[index];
        result[pair[0]] = pair[1];
      }
      return result;
    }

    /**
     * Gets the first element of `array`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @alias first
     * @category Array
     * @param {Array} array The array to query.
     * @returns {*} Returns the first element of `array`.
     * @example
     *
     * _.head([1, 2, 3]);
     * // => 1
     *
     * _.head([]);
     * // => undefined
     */
    function head(array) {
      return (array && array.length) ? array[0] : undefined;
    }

    /**
     * Gets the index at which the first occurrence of `value` is found in `array`
     * using [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
     * for equality comparisons. If `fromIndex` is negative, it's used as the
     * offset from the end of `array`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {*} value The value to search for.
     * @param {number} [fromIndex=0] The index to search from.
     * @returns {number} Returns the index of the matched value, else `-1`.
     * @example
     *
     * _.indexOf([1, 2, 1, 2], 2);
     * // => 1
     *
     * // Search from the `fromIndex`.
     * _.indexOf([1, 2, 1, 2], 2, 2);
     * // => 3
     */
    function indexOf(array, value, fromIndex) {
      var length = array == null ? 0 : array.length;
      if (!length) {
        return -1;
      }
      var index = fromIndex == null ? 0 : toInteger(fromIndex);
      if (index < 0) {
        index = nativeMax(length + index, 0);
      }
      return baseIndexOf(array, value, index);
    }

    /**
     * Gets all but the last element of `array`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The array to query.
     * @returns {Array} Returns the slice of `array`.
     * @example
     *
     * _.initial([1, 2, 3]);
     * // => [1, 2]
     */
    function initial(array) {
      var length = array == null ? 0 : array.length;
      return length ? baseSlice(array, 0, -1) : [];
    }

    /**
     * Creates an array of unique values that are included in all given arrays
     * using [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
     * for equality comparisons. The order and references of result values are
     * determined by the first array.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {...Array} [arrays] The arrays to inspect.
     * @returns {Array} Returns the new array of intersecting values.
     * @example
     *
     * _.intersection([2, 1], [2, 3]);
     * // => [2]
     */
    var intersection = baseRest(function(arrays) {
      var mapped = arrayMap(arrays, castArrayLikeObject);
      return (mapped.length && mapped[0] === arrays[0])
        ? baseIntersection(mapped)
        : [];
    });

    /**
     * This method is like `_.intersection` except that it accepts `iteratee`
     * which is invoked for each element of each `arrays` to generate the criterion
     * by which they're compared. The order and references of result values are
     * determined by the first array. The iteratee is invoked with one argument:
     * (value).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {...Array} [arrays] The arrays to inspect.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {Array} Returns the new array of intersecting values.
     * @example
     *
     * _.intersectionBy([2.1, 1.2], [2.3, 3.4], Math.floor);
     * // => [2.1]
     *
     * // The `_.property` iteratee shorthand.
     * _.intersectionBy([{ 'x': 1 }], [{ 'x': 2 }, { 'x': 1 }], 'x');
     * // => [{ 'x': 1 }]
     */
    var intersectionBy = baseRest(function(arrays) {
      var iteratee = last(arrays),
          mapped = arrayMap(arrays, castArrayLikeObject);

      if (iteratee === last(mapped)) {
        iteratee = undefined;
      } else {
        mapped.pop();
      }
      return (mapped.length && mapped[0] === arrays[0])
        ? baseIntersection(mapped, getIteratee(iteratee, 2))
        : [];
    });

    /**
     * This method is like `_.intersection` except that it accepts `comparator`
     * which is invoked to compare elements of `arrays`. The order and references
     * of result values are determined by the first array. The comparator is
     * invoked with two arguments: (arrVal, othVal).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {...Array} [arrays] The arrays to inspect.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns the new array of intersecting values.
     * @example
     *
     * var objects = [{ 'x': 1, 'y': 2 }, { 'x': 2, 'y': 1 }];
     * var others = [{ 'x': 1, 'y': 1 }, { 'x': 1, 'y': 2 }];
     *
     * _.intersectionWith(objects, others, _.isEqual);
     * // => [{ 'x': 1, 'y': 2 }]
     */
    var intersectionWith = baseRest(function(arrays) {
      var comparator = last(arrays),
          mapped = arrayMap(arrays, castArrayLikeObject);

      comparator = typeof comparator == 'function' ? comparator : undefined;
      if (comparator) {
        mapped.pop();
      }
      return (mapped.length && mapped[0] === arrays[0])
        ? baseIntersection(mapped, undefined, comparator)
        : [];
    });

    /**
     * Converts all elements in `array` into a string separated by `separator`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to convert.
     * @param {string} [separator=','] The element separator.
     * @returns {string} Returns the joined string.
     * @example
     *
     * _.join(['a', 'b', 'c'], '~');
     * // => 'a~b~c'
     */
    function join(array, separator) {
      return array == null ? '' : nativeJoin.call(array, separator);
    }

    /**
     * Gets the last element of `array`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The array to query.
     * @returns {*} Returns the last element of `array`.
     * @example
     *
     * _.last([1, 2, 3]);
     * // => 3
     */
    function last(array) {
      var length = array == null ? 0 : array.length;
      return length ? array[length - 1] : undefined;
    }

    /**
     * This method is like `_.indexOf` except that it iterates over elements of
     * `array` from right to left.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {*} value The value to search for.
     * @param {number} [fromIndex=array.length-1] The index to search from.
     * @returns {number} Returns the index of the matched value, else `-1`.
     * @example
     *
     * _.lastIndexOf([1, 2, 1, 2], 2);
     * // => 3
     *
     * // Search from the `fromIndex`.
     * _.lastIndexOf([1, 2, 1, 2], 2, 2);
     * // => 1
     */
    function lastIndexOf(array, value, fromIndex) {
      var length = array == null ? 0 : array.length;
      if (!length) {
        return -1;
      }
      var index = length;
      if (fromIndex !== undefined) {
        index = toInteger(fromIndex);
        index = index < 0 ? nativeMax(length + index, 0) : nativeMin(index, length - 1);
      }
      return value === value
        ? strictLastIndexOf(array, value, index)
        : baseFindIndex(array, baseIsNaN, index, true);
    }

    /**
     * Gets the element at index `n` of `array`. If `n` is negative, the nth
     * element from the end is returned.
     *
     * @static
     * @memberOf _
     * @since 4.11.0
     * @category Array
     * @param {Array} array The array to query.
     * @param {number} [n=0] The index of the element to return.
     * @returns {*} Returns the nth element of `array`.
     * @example
     *
     * var array = ['a', 'b', 'c', 'd'];
     *
     * _.nth(array, 1);
     * // => 'b'
     *
     * _.nth(array, -2);
     * // => 'c';
     */
    function nth(array, n) {
      return (array && array.length) ? baseNth(array, toInteger(n)) : undefined;
    }

    /**
     * Removes all given values from `array` using
     * [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
     * for equality comparisons.
     *
     * **Note:** Unlike `_.without`, this method mutates `array`. Use `_.remove`
     * to remove elements from an array by predicate.
     *
     * @static
     * @memberOf _
     * @since 2.0.0
     * @category Array
     * @param {Array} array The array to modify.
     * @param {...*} [values] The values to remove.
     * @returns {Array} Returns `array`.
     * @example
     *
     * var array = ['a', 'b', 'c', 'a', 'b', 'c'];
     *
     * _.pull(array, 'a', 'c');
     * console.log(array);
     * // => ['b', 'b']
     */
    var pull = baseRest(pullAll);

    /**
     * This method is like `_.pull` except that it accepts an array of values to remove.
     *
     * **Note:** Unlike `_.difference`, this method mutates `array`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to modify.
     * @param {Array} values The values to remove.
     * @returns {Array} Returns `array`.
     * @example
     *
     * var array = ['a', 'b', 'c', 'a', 'b', 'c'];
     *
     * _.pullAll(array, ['a', 'c']);
     * console.log(array);
     * // => ['b', 'b']
     */
    function pullAll(array, values) {
      return (array && array.length && values && values.length)
        ? basePullAll(array, values)
        : array;
    }

    /**
     * This method is like `_.pullAll` except that it accepts `iteratee` which is
     * invoked for each element of `array` and `values` to generate the criterion
     * by which they're compared. The iteratee is invoked with one argument: (value).
     *
     * **Note:** Unlike `_.differenceBy`, this method mutates `array`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to modify.
     * @param {Array} values The values to remove.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {Array} Returns `array`.
     * @example
     *
     * var array = [{ 'x': 1 }, { 'x': 2 }, { 'x': 3 }, { 'x': 1 }];
     *
     * _.pullAllBy(array, [{ 'x': 1 }, { 'x': 3 }], 'x');
     * console.log(array);
     * // => [{ 'x': 2 }]
     */
    function pullAllBy(array, values, iteratee) {
      return (array && array.length && values && values.length)
        ? basePullAll(array, values, getIteratee(iteratee, 2))
        : array;
    }

    /**
     * This method is like `_.pullAll` except that it accepts `comparator` which
     * is invoked to compare elements of `array` to `values`. The comparator is
     * invoked with two arguments: (arrVal, othVal).
     *
     * **Note:** Unlike `_.differenceWith`, this method mutates `array`.
     *
     * @static
     * @memberOf _
     * @since 4.6.0
     * @category Array
     * @param {Array} array The array to modify.
     * @param {Array} values The values to remove.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns `array`.
     * @example
     *
     * var array = [{ 'x': 1, 'y': 2 }, { 'x': 3, 'y': 4 }, { 'x': 5, 'y': 6 }];
     *
     * _.pullAllWith(array, [{ 'x': 3, 'y': 4 }], _.isEqual);
     * console.log(array);
     * // => [{ 'x': 1, 'y': 2 }, { 'x': 5, 'y': 6 }]
     */
    function pullAllWith(array, values, comparator) {
      return (array && array.length && values && values.length)
        ? basePullAll(array, values, undefined, comparator)
        : array;
    }

    /**
     * Removes elements from `array` corresponding to `indexes` and returns an
     * array of removed elements.
     *
     * **Note:** Unlike `_.at`, this method mutates `array`.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The array to modify.
     * @param {...(number|number[])} [indexes] The indexes of elements to remove.
     * @returns {Array} Returns the new array of removed elements.
     * @example
     *
     * var array = ['a', 'b', 'c', 'd'];
     * var pulled = _.pullAt(array, [1, 3]);
     *
     * console.log(array);
     * // => ['a', 'c']
     *
     * console.log(pulled);
     * // => ['b', 'd']
     */
    var pullAt = flatRest(function(array, indexes) {
      var length = array == null ? 0 : array.length,
          result = baseAt(array, indexes);

      basePullAt(array, arrayMap(indexes, function(index) {
        return isIndex(index, length) ? +index : index;
      }).sort(compareAscending));

      return result;
    });

    /**
     * Removes all elements from `array` that `predicate` returns truthy for
     * and returns an array of the removed elements. The predicate is invoked
     * with three arguments: (value, index, array).
     *
     * **Note:** Unlike `_.filter`, this method mutates `array`. Use `_.pull`
     * to pull elements from an array by value.
     *
     * @static
     * @memberOf _
     * @since 2.0.0
     * @category Array
     * @param {Array} array The array to modify.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the new array of removed elements.
     * @example
     *
     * var array = [1, 2, 3, 4];
     * var evens = _.remove(array, function(n) {
     *   return n % 2 == 0;
     * });
     *
     * console.log(array);
     * // => [1, 3]
     *
     * console.log(evens);
     * // => [2, 4]
     */
    function remove(array, predicate) {
      var result = [];
      if (!(array && array.length)) {
        return result;
      }
      var index = -1,
          indexes = [],
          length = array.length;

      predicate = getIteratee(predicate, 3);
      while (++index < length) {
        var value = array[index];
        if (predicate(value, index, array)) {
          result.push(value);
          indexes.push(index);
        }
      }
      basePullAt(array, indexes);
      return result;
    }

    /**
     * Reverses `array` so that the first element becomes the last, the second
     * element becomes the second to last, and so on.
     *
     * **Note:** This method mutates `array` and is based on
     * [`Array#reverse`](https://mdn.io/Array/reverse).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to modify.
     * @returns {Array} Returns `array`.
     * @example
     *
     * var array = [1, 2, 3];
     *
     * _.reverse(array);
     * // => [3, 2, 1]
     *
     * console.log(array);
     * // => [3, 2, 1]
     */
    function reverse(array) {
      return array == null ? array : nativeReverse.call(array);
    }

    /**
     * Creates a slice of `array` from `start` up to, but not including, `end`.
     *
     * **Note:** This method is used instead of
     * [`Array#slice`](https://mdn.io/Array/slice) to ensure dense arrays are
     * returned.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The array to slice.
     * @param {number} [start=0] The start position.
     * @param {number} [end=array.length] The end position.
     * @returns {Array} Returns the slice of `array`.
     */
    function slice(array, start, end) {
      var length = array == null ? 0 : array.length;
      if (!length) {
        return [];
      }
      if (end && typeof end != 'number' && isIterateeCall(array, start, end)) {
        start = 0;
        end = length;
      }
      else {
        start = start == null ? 0 : toInteger(start);
        end = end === undefined ? length : toInteger(end);
      }
      return baseSlice(array, start, end);
    }

    /**
     * Uses a binary search to determine the lowest index at which `value`
     * should be inserted into `array` in order to maintain its sort order.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The sorted array to inspect.
     * @param {*} value The value to evaluate.
     * @returns {number} Returns the index at which `value` should be inserted
     *  into `array`.
     * @example
     *
     * _.sortedIndex([30, 50], 40);
     * // => 1
     */
    function sortedIndex(array, value) {
      return baseSortedIndex(array, value);
    }

    /**
     * This method is like `_.sortedIndex` except that it accepts `iteratee`
     * which is invoked for `value` and each element of `array` to compute their
     * sort ranking. The iteratee is invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The sorted array to inspect.
     * @param {*} value The value to evaluate.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {number} Returns the index at which `value` should be inserted
     *  into `array`.
     * @example
     *
     * var objects = [{ 'x': 4 }, { 'x': 5 }];
     *
     * _.sortedIndexBy(objects, { 'x': 4 }, function(o) { return o.x; });
     * // => 0
     *
     * // The `_.property` iteratee shorthand.
     * _.sortedIndexBy(objects, { 'x': 4 }, 'x');
     * // => 0
     */
    function sortedIndexBy(array, value, iteratee) {
      return baseSortedIndexBy(array, value, getIteratee(iteratee, 2));
    }

    /**
     * This method is like `_.indexOf` except that it performs a binary
     * search on a sorted `array`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {*} value The value to search for.
     * @returns {number} Returns the index of the matched value, else `-1`.
     * @example
     *
     * _.sortedIndexOf([4, 5, 5, 5, 6], 5);
     * // => 1
     */
    function sortedIndexOf(array, value) {
      var length = array == null ? 0 : array.length;
      if (length) {
        var index = baseSortedIndex(array, value);
        if (index < length && eq(array[index], value)) {
          return index;
        }
      }
      return -1;
    }

    /**
     * This method is like `_.sortedIndex` except that it returns the highest
     * index at which `value` should be inserted into `array` in order to
     * maintain its sort order.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The sorted array to inspect.
     * @param {*} value The value to evaluate.
     * @returns {number} Returns the index at which `value` should be inserted
     *  into `array`.
     * @example
     *
     * _.sortedLastIndex([4, 5, 5, 5, 6], 5);
     * // => 4
     */
    function sortedLastIndex(array, value) {
      return baseSortedIndex(array, value, true);
    }

    /**
     * This method is like `_.sortedLastIndex` except that it accepts `iteratee`
     * which is invoked for `value` and each element of `array` to compute their
     * sort ranking. The iteratee is invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The sorted array to inspect.
     * @param {*} value The value to evaluate.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {number} Returns the index at which `value` should be inserted
     *  into `array`.
     * @example
     *
     * var objects = [{ 'x': 4 }, { 'x': 5 }];
     *
     * _.sortedLastIndexBy(objects, { 'x': 4 }, function(o) { return o.x; });
     * // => 1
     *
     * // The `_.property` iteratee shorthand.
     * _.sortedLastIndexBy(objects, { 'x': 4 }, 'x');
     * // => 1
     */
    function sortedLastIndexBy(array, value, iteratee) {
      return baseSortedIndexBy(array, value, getIteratee(iteratee, 2), true);
    }

    /**
     * This method is like `_.lastIndexOf` except that it performs a binary
     * search on a sorted `array`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {*} value The value to search for.
     * @returns {number} Returns the index of the matched value, else `-1`.
     * @example
     *
     * _.sortedLastIndexOf([4, 5, 5, 5, 6], 5);
     * // => 3
     */
    function sortedLastIndexOf(array, value) {
      var length = array == null ? 0 : array.length;
      if (length) {
        var index = baseSortedIndex(array, value, true) - 1;
        if (eq(array[index], value)) {
          return index;
        }
      }
      return -1;
    }

    /**
     * This method is like `_.uniq` except that it's designed and optimized
     * for sorted arrays.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @returns {Array} Returns the new duplicate free array.
     * @example
     *
     * _.sortedUniq([1, 1, 2]);
     * // => [1, 2]
     */
    function sortedUniq(array) {
      return (array && array.length)
        ? baseSortedUniq(array)
        : [];
    }

    /**
     * This method is like `_.uniqBy` except that it's designed and optimized
     * for sorted arrays.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {Function} [iteratee] The iteratee invoked per element.
     * @returns {Array} Returns the new duplicate free array.
     * @example
     *
     * _.sortedUniqBy([1.1, 1.2, 2.3, 2.4], Math.floor);
     * // => [1.1, 2.3]
     */
    function sortedUniqBy(array, iteratee) {
      return (array && array.length)
        ? baseSortedUniq(array, getIteratee(iteratee, 2))
        : [];
    }

    /**
     * Gets all but the first element of `array`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to query.
     * @returns {Array} Returns the slice of `array`.
     * @example
     *
     * _.tail([1, 2, 3]);
     * // => [2, 3]
     */
    function tail(array) {
      var length = array == null ? 0 : array.length;
      return length ? baseSlice(array, 1, length) : [];
    }

    /**
     * Creates a slice of `array` with `n` elements taken from the beginning.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The array to query.
     * @param {number} [n=1] The number of elements to take.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Array} Returns the slice of `array`.
     * @example
     *
     * _.take([1, 2, 3]);
     * // => [1]
     *
     * _.take([1, 2, 3], 2);
     * // => [1, 2]
     *
     * _.take([1, 2, 3], 5);
     * // => [1, 2, 3]
     *
     * _.take([1, 2, 3], 0);
     * // => []
     */
    function take(array, n, guard) {
      if (!(array && array.length)) {
        return [];
      }
      n = (guard || n === undefined) ? 1 : toInteger(n);
      return baseSlice(array, 0, n < 0 ? 0 : n);
    }

    /**
     * Creates a slice of `array` with `n` elements taken from the end.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The array to query.
     * @param {number} [n=1] The number of elements to take.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Array} Returns the slice of `array`.
     * @example
     *
     * _.takeRight([1, 2, 3]);
     * // => [3]
     *
     * _.takeRight([1, 2, 3], 2);
     * // => [2, 3]
     *
     * _.takeRight([1, 2, 3], 5);
     * // => [1, 2, 3]
     *
     * _.takeRight([1, 2, 3], 0);
     * // => []
     */
    function takeRight(array, n, guard) {
      var length = array == null ? 0 : array.length;
      if (!length) {
        return [];
      }
      n = (guard || n === undefined) ? 1 : toInteger(n);
      n = length - n;
      return baseSlice(array, n < 0 ? 0 : n, length);
    }

    /**
     * Creates a slice of `array` with elements taken from the end. Elements are
     * taken until `predicate` returns falsey. The predicate is invoked with
     * three arguments: (value, index, array).
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The array to query.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the slice of `array`.
     * @example
     *
     * var users = [
     *   { 'user': 'barney',  'active': true },
     *   { 'user': 'fred',    'active': false },
     *   { 'user': 'pebbles', 'active': false }
     * ];
     *
     * _.takeRightWhile(users, function(o) { return !o.active; });
     * // => objects for ['fred', 'pebbles']
     *
     * // The `_.matches` iteratee shorthand.
     * _.takeRightWhile(users, { 'user': 'pebbles', 'active': false });
     * // => objects for ['pebbles']
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.takeRightWhile(users, ['active', false]);
     * // => objects for ['fred', 'pebbles']
     *
     * // The `_.property` iteratee shorthand.
     * _.takeRightWhile(users, 'active');
     * // => []
     */
    function takeRightWhile(array, predicate) {
      return (array && array.length)
        ? baseWhile(array, getIteratee(predicate, 3), false, true)
        : [];
    }

    /**
     * Creates a slice of `array` with elements taken from the beginning. Elements
     * are taken until `predicate` returns falsey. The predicate is invoked with
     * three arguments: (value, index, array).
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Array
     * @param {Array} array The array to query.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the slice of `array`.
     * @example
     *
     * var users = [
     *   { 'user': 'barney',  'active': false },
     *   { 'user': 'fred',    'active': false },
     *   { 'user': 'pebbles', 'active': true }
     * ];
     *
     * _.takeWhile(users, function(o) { return !o.active; });
     * // => objects for ['barney', 'fred']
     *
     * // The `_.matches` iteratee shorthand.
     * _.takeWhile(users, { 'user': 'barney', 'active': false });
     * // => objects for ['barney']
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.takeWhile(users, ['active', false]);
     * // => objects for ['barney', 'fred']
     *
     * // The `_.property` iteratee shorthand.
     * _.takeWhile(users, 'active');
     * // => []
     */
    function takeWhile(array, predicate) {
      return (array && array.length)
        ? baseWhile(array, getIteratee(predicate, 3))
        : [];
    }

    /**
     * Creates an array of unique values, in order, from all given arrays using
     * [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
     * for equality comparisons.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {...Array} [arrays] The arrays to inspect.
     * @returns {Array} Returns the new array of combined values.
     * @example
     *
     * _.union([2], [1, 2]);
     * // => [2, 1]
     */
    var union = baseRest(function(arrays) {
      return baseUniq(baseFlatten(arrays, 1, isArrayLikeObject, true));
    });

    /**
     * This method is like `_.union` except that it accepts `iteratee` which is
     * invoked for each element of each `arrays` to generate the criterion by
     * which uniqueness is computed. Result values are chosen from the first
     * array in which the value occurs. The iteratee is invoked with one argument:
     * (value).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {...Array} [arrays] The arrays to inspect.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {Array} Returns the new array of combined values.
     * @example
     *
     * _.unionBy([2.1], [1.2, 2.3], Math.floor);
     * // => [2.1, 1.2]
     *
     * // The `_.property` iteratee shorthand.
     * _.unionBy([{ 'x': 1 }], [{ 'x': 2 }, { 'x': 1 }], 'x');
     * // => [{ 'x': 1 }, { 'x': 2 }]
     */
    var unionBy = baseRest(function(arrays) {
      var iteratee = last(arrays);
      if (isArrayLikeObject(iteratee)) {
        iteratee = undefined;
      }
      return baseUniq(baseFlatten(arrays, 1, isArrayLikeObject, true), getIteratee(iteratee, 2));
    });

    /**
     * This method is like `_.union` except that it accepts `comparator` which
     * is invoked to compare elements of `arrays`. Result values are chosen from
     * the first array in which the value occurs. The comparator is invoked
     * with two arguments: (arrVal, othVal).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {...Array} [arrays] The arrays to inspect.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns the new array of combined values.
     * @example
     *
     * var objects = [{ 'x': 1, 'y': 2 }, { 'x': 2, 'y': 1 }];
     * var others = [{ 'x': 1, 'y': 1 }, { 'x': 1, 'y': 2 }];
     *
     * _.unionWith(objects, others, _.isEqual);
     * // => [{ 'x': 1, 'y': 2 }, { 'x': 2, 'y': 1 }, { 'x': 1, 'y': 1 }]
     */
    var unionWith = baseRest(function(arrays) {
      var comparator = last(arrays);
      comparator = typeof comparator == 'function' ? comparator : undefined;
      return baseUniq(baseFlatten(arrays, 1, isArrayLikeObject, true), undefined, comparator);
    });

    /**
     * Creates a duplicate-free version of an array, using
     * [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
     * for equality comparisons, in which only the first occurrence of each element
     * is kept. The order of result values is determined by the order they occur
     * in the array.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @returns {Array} Returns the new duplicate free array.
     * @example
     *
     * _.uniq([2, 1, 2]);
     * // => [2, 1]
     */
    function uniq(array) {
      return (array && array.length) ? baseUniq(array) : [];
    }

    /**
     * This method is like `_.uniq` except that it accepts `iteratee` which is
     * invoked for each element in `array` to generate the criterion by which
     * uniqueness is computed. The order of result values is determined by the
     * order they occur in the array. The iteratee is invoked with one argument:
     * (value).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {Array} Returns the new duplicate free array.
     * @example
     *
     * _.uniqBy([2.1, 1.2, 2.3], Math.floor);
     * // => [2.1, 1.2]
     *
     * // The `_.property` iteratee shorthand.
     * _.uniqBy([{ 'x': 1 }, { 'x': 2 }, { 'x': 1 }], 'x');
     * // => [{ 'x': 1 }, { 'x': 2 }]
     */
    function uniqBy(array, iteratee) {
      return (array && array.length) ? baseUniq(array, getIteratee(iteratee, 2)) : [];
    }

    /**
     * This method is like `_.uniq` except that it accepts `comparator` which
     * is invoked to compare elements of `array`. The order of result values is
     * determined by the order they occur in the array.The comparator is invoked
     * with two arguments: (arrVal, othVal).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns the new duplicate free array.
     * @example
     *
     * var objects = [{ 'x': 1, 'y': 2 }, { 'x': 2, 'y': 1 }, { 'x': 1, 'y': 2 }];
     *
     * _.uniqWith(objects, _.isEqual);
     * // => [{ 'x': 1, 'y': 2 }, { 'x': 2, 'y': 1 }]
     */
    function uniqWith(array, comparator) {
      comparator = typeof comparator == 'function' ? comparator : undefined;
      return (array && array.length) ? baseUniq(array, undefined, comparator) : [];
    }

    /**
     * This method is like `_.zip` except that it accepts an array of grouped
     * elements and creates an array regrouping the elements to their pre-zip
     * configuration.
     *
     * @static
     * @memberOf _
     * @since 1.2.0
     * @category Array
     * @param {Array} array The array of grouped elements to process.
     * @returns {Array} Returns the new array of regrouped elements.
     * @example
     *
     * var zipped = _.zip(['a', 'b'], [1, 2], [true, false]);
     * // => [['a', 1, true], ['b', 2, false]]
     *
     * _.unzip(zipped);
     * // => [['a', 'b'], [1, 2], [true, false]]
     */
    function unzip(array) {
      if (!(array && array.length)) {
        return [];
      }
      var length = 0;
      array = arrayFilter(array, function(group) {
        if (isArrayLikeObject(group)) {
          length = nativeMax(group.length, length);
          return true;
        }
      });
      return baseTimes(length, function(index) {
        return arrayMap(array, baseProperty(index));
      });
    }

    /**
     * This method is like `_.unzip` except that it accepts `iteratee` to specify
     * how regrouped values should be combined. The iteratee is invoked with the
     * elements of each group: (...group).
     *
     * @static
     * @memberOf _
     * @since 3.8.0
     * @category Array
     * @param {Array} array The array of grouped elements to process.
     * @param {Function} [iteratee=_.identity] The function to combine
     *  regrouped values.
     * @returns {Array} Returns the new array of regrouped elements.
     * @example
     *
     * var zipped = _.zip([1, 2], [10, 20], [100, 200]);
     * // => [[1, 10, 100], [2, 20, 200]]
     *
     * _.unzipWith(zipped, _.add);
     * // => [3, 30, 300]
     */
    function unzipWith(array, iteratee) {
      if (!(array && array.length)) {
        return [];
      }
      var result = unzip(array);
      if (iteratee == null) {
        return result;
      }
      return arrayMap(result, function(group) {
        return apply(iteratee, undefined, group);
      });
    }

    /**
     * Creates an array excluding all given values using
     * [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
     * for equality comparisons.
     *
     * **Note:** Unlike `_.pull`, this method returns a new array.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {Array} array The array to inspect.
     * @param {...*} [values] The values to exclude.
     * @returns {Array} Returns the new array of filtered values.
     * @see _.difference, _.xor
     * @example
     *
     * _.without([2, 1, 2, 3], 1, 2);
     * // => [3]
     */
    var without = baseRest(function(array, values) {
      return isArrayLikeObject(array)
        ? baseDifference(array, values)
        : [];
    });

    /**
     * Creates an array of unique values that is the
     * [symmetric difference](https://en.wikipedia.org/wiki/Symmetric_difference)
     * of the given arrays. The order of result values is determined by the order
     * they occur in the arrays.
     *
     * @static
     * @memberOf _
     * @since 2.4.0
     * @category Array
     * @param {...Array} [arrays] The arrays to inspect.
     * @returns {Array} Returns the new array of filtered values.
     * @see _.difference, _.without
     * @example
     *
     * _.xor([2, 1], [2, 3]);
     * // => [1, 3]
     */
    var xor = baseRest(function(arrays) {
      return baseXor(arrayFilter(arrays, isArrayLikeObject));
    });

    /**
     * This method is like `_.xor` except that it accepts `iteratee` which is
     * invoked for each element of each `arrays` to generate the criterion by
     * which by which they're compared. The order of result values is determined
     * by the order they occur in the arrays. The iteratee is invoked with one
     * argument: (value).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {...Array} [arrays] The arrays to inspect.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {Array} Returns the new array of filtered values.
     * @example
     *
     * _.xorBy([2.1, 1.2], [2.3, 3.4], Math.floor);
     * // => [1.2, 3.4]
     *
     * // The `_.property` iteratee shorthand.
     * _.xorBy([{ 'x': 1 }], [{ 'x': 2 }, { 'x': 1 }], 'x');
     * // => [{ 'x': 2 }]
     */
    var xorBy = baseRest(function(arrays) {
      var iteratee = last(arrays);
      if (isArrayLikeObject(iteratee)) {
        iteratee = undefined;
      }
      return baseXor(arrayFilter(arrays, isArrayLikeObject), getIteratee(iteratee, 2));
    });

    /**
     * This method is like `_.xor` except that it accepts `comparator` which is
     * invoked to compare elements of `arrays`. The order of result values is
     * determined by the order they occur in the arrays. The comparator is invoked
     * with two arguments: (arrVal, othVal).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Array
     * @param {...Array} [arrays] The arrays to inspect.
     * @param {Function} [comparator] The comparator invoked per element.
     * @returns {Array} Returns the new array of filtered values.
     * @example
     *
     * var objects = [{ 'x': 1, 'y': 2 }, { 'x': 2, 'y': 1 }];
     * var others = [{ 'x': 1, 'y': 1 }, { 'x': 1, 'y': 2 }];
     *
     * _.xorWith(objects, others, _.isEqual);
     * // => [{ 'x': 2, 'y': 1 }, { 'x': 1, 'y': 1 }]
     */
    var xorWith = baseRest(function(arrays) {
      var comparator = last(arrays);
      comparator = typeof comparator == 'function' ? comparator : undefined;
      return baseXor(arrayFilter(arrays, isArrayLikeObject), undefined, comparator);
    });

    /**
     * Creates an array of grouped elements, the first of which contains the
     * first elements of the given arrays, the second of which contains the
     * second elements of the given arrays, and so on.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Array
     * @param {...Array} [arrays] The arrays to process.
     * @returns {Array} Returns the new array of grouped elements.
     * @example
     *
     * _.zip(['a', 'b'], [1, 2], [true, false]);
     * // => [['a', 1, true], ['b', 2, false]]
     */
    var zip = baseRest(unzip);

    /**
     * This method is like `_.fromPairs` except that it accepts two arrays,
     * one of property identifiers and one of corresponding values.
     *
     * @static
     * @memberOf _
     * @since 0.4.0
     * @category Array
     * @param {Array} [props=[]] The property identifiers.
     * @param {Array} [values=[]] The property values.
     * @returns {Object} Returns the new object.
     * @example
     *
     * _.zipObject(['a', 'b'], [1, 2]);
     * // => { 'a': 1, 'b': 2 }
     */
    function zipObject(props, values) {
      return baseZipObject(props || [], values || [], assignValue);
    }

    /**
     * This method is like `_.zipObject` except that it supports property paths.
     *
     * @static
     * @memberOf _
     * @since 4.1.0
     * @category Array
     * @param {Array} [props=[]] The property identifiers.
     * @param {Array} [values=[]] The property values.
     * @returns {Object} Returns the new object.
     * @example
     *
     * _.zipObjectDeep(['a.b[0].c', 'a.b[1].d'], [1, 2]);
     * // => { 'a': { 'b': [{ 'c': 1 }, { 'd': 2 }] } }
     */
    function zipObjectDeep(props, values) {
      return baseZipObject(props || [], values || [], baseSet);
    }

    /**
     * This method is like `_.zip` except that it accepts `iteratee` to specify
     * how grouped values should be combined. The iteratee is invoked with the
     * elements of each group: (...group).
     *
     * @static
     * @memberOf _
     * @since 3.8.0
     * @category Array
     * @param {...Array} [arrays] The arrays to process.
     * @param {Function} [iteratee=_.identity] The function to combine
     *  grouped values.
     * @returns {Array} Returns the new array of grouped elements.
     * @example
     *
     * _.zipWith([1, 2], [10, 20], [100, 200], function(a, b, c) {
     *   return a + b + c;
     * });
     * // => [111, 222]
     */
    var zipWith = baseRest(function(arrays) {
      var length = arrays.length,
          iteratee = length > 1 ? arrays[length - 1] : undefined;

      iteratee = typeof iteratee == 'function' ? (arrays.pop(), iteratee) : undefined;
      return unzipWith(arrays, iteratee);
    });

    /*------------------------------------------------------------------------*/

    /**
     * Creates a `lodash` wrapper instance that wraps `value` with explicit method
     * chain sequences enabled. The result of such sequences must be unwrapped
     * with `_#value`.
     *
     * @static
     * @memberOf _
     * @since 1.3.0
     * @category Seq
     * @param {*} value The value to wrap.
     * @returns {Object} Returns the new `lodash` wrapper instance.
     * @example
     *
     * var users = [
     *   { 'user': 'barney',  'age': 36 },
     *   { 'user': 'fred',    'age': 40 },
     *   { 'user': 'pebbles', 'age': 1 }
     * ];
     *
     * var youngest = _
     *   .chain(users)
     *   .sortBy('age')
     *   .map(function(o) {
     *     return o.user + ' is ' + o.age;
     *   })
     *   .head()
     *   .value();
     * // => 'pebbles is 1'
     */
    function chain(value) {
      var result = lodash(value);
      result.__chain__ = true;
      return result;
    }

    /**
     * This method invokes `interceptor` and returns `value`. The interceptor
     * is invoked with one argument; (value). The purpose of this method is to
     * "tap into" a method chain sequence in order to modify intermediate results.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Seq
     * @param {*} value The value to provide to `interceptor`.
     * @param {Function} interceptor The function to invoke.
     * @returns {*} Returns `value`.
     * @example
     *
     * _([1, 2, 3])
     *  .tap(function(array) {
     *    // Mutate input array.
     *    array.pop();
     *  })
     *  .reverse()
     *  .value();
     * // => [2, 1]
     */
    function tap(value, interceptor) {
      interceptor(value);
      return value;
    }

    /**
     * This method is like `_.tap` except that it returns the result of `interceptor`.
     * The purpose of this method is to "pass thru" values replacing intermediate
     * results in a method chain sequence.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Seq
     * @param {*} value The value to provide to `interceptor`.
     * @param {Function} interceptor The function to invoke.
     * @returns {*} Returns the result of `interceptor`.
     * @example
     *
     * _('  abc  ')
     *  .chain()
     *  .trim()
     *  .thru(function(value) {
     *    return [value];
     *  })
     *  .value();
     * // => ['abc']
     */
    function thru(value, interceptor) {
      return interceptor(value);
    }

    /**
     * This method is the wrapper version of `_.at`.
     *
     * @name at
     * @memberOf _
     * @since 1.0.0
     * @category Seq
     * @param {...(string|string[])} [paths] The property paths to pick.
     * @returns {Object} Returns the new `lodash` wrapper instance.
     * @example
     *
     * var object = { 'a': [{ 'b': { 'c': 3 } }, 4] };
     *
     * _(object).at(['a[0].b.c', 'a[1]']).value();
     * // => [3, 4]
     */
    var wrapperAt = flatRest(function(paths) {
      var length = paths.length,
          start = length ? paths[0] : 0,
          value = this.__wrapped__,
          interceptor = function(object) { return baseAt(object, paths); };

      if (length > 1 || this.__actions__.length ||
          !(value instanceof LazyWrapper) || !isIndex(start)) {
        return this.thru(interceptor);
      }
      value = value.slice(start, +start + (length ? 1 : 0));
      value.__actions__.push({
        'func': thru,
        'args': [interceptor],
        'thisArg': undefined
      });
      return new LodashWrapper(value, this.__chain__).thru(function(array) {
        if (length && !array.length) {
          array.push(undefined);
        }
        return array;
      });
    });

    /**
     * Creates a `lodash` wrapper instance with explicit method chain sequences enabled.
     *
     * @name chain
     * @memberOf _
     * @since 0.1.0
     * @category Seq
     * @returns {Object} Returns the new `lodash` wrapper instance.
     * @example
     *
     * var users = [
     *   { 'user': 'barney', 'age': 36 },
     *   { 'user': 'fred',   'age': 40 }
     * ];
     *
     * // A sequence without explicit chaining.
     * _(users).head();
     * // => { 'user': 'barney', 'age': 36 }
     *
     * // A sequence with explicit chaining.
     * _(users)
     *   .chain()
     *   .head()
     *   .pick('user')
     *   .value();
     * // => { 'user': 'barney' }
     */
    function wrapperChain() {
      return chain(this);
    }

    /**
     * Executes the chain sequence and returns the wrapped result.
     *
     * @name commit
     * @memberOf _
     * @since 3.2.0
     * @category Seq
     * @returns {Object} Returns the new `lodash` wrapper instance.
     * @example
     *
     * var array = [1, 2];
     * var wrapped = _(array).push(3);
     *
     * console.log(array);
     * // => [1, 2]
     *
     * wrapped = wrapped.commit();
     * console.log(array);
     * // => [1, 2, 3]
     *
     * wrapped.last();
     * // => 3
     *
     * console.log(array);
     * // => [1, 2, 3]
     */
    function wrapperCommit() {
      return new LodashWrapper(this.value(), this.__chain__);
    }

    /**
     * Gets the next value on a wrapped object following the
     * [iterator protocol](https://mdn.io/iteration_protocols#iterator).
     *
     * @name next
     * @memberOf _
     * @since 4.0.0
     * @category Seq
     * @returns {Object} Returns the next iterator value.
     * @example
     *
     * var wrapped = _([1, 2]);
     *
     * wrapped.next();
     * // => { 'done': false, 'value': 1 }
     *
     * wrapped.next();
     * // => { 'done': false, 'value': 2 }
     *
     * wrapped.next();
     * // => { 'done': true, 'value': undefined }
     */
    function wrapperNext() {
      if (this.__values__ === undefined) {
        this.__values__ = toArray(this.value());
      }
      var done = this.__index__ >= this.__values__.length,
          value = done ? undefined : this.__values__[this.__index__++];

      return { 'done': done, 'value': value };
    }

    /**
     * Enables the wrapper to be iterable.
     *
     * @name Symbol.iterator
     * @memberOf _
     * @since 4.0.0
     * @category Seq
     * @returns {Object} Returns the wrapper object.
     * @example
     *
     * var wrapped = _([1, 2]);
     *
     * wrapped[Symbol.iterator]() === wrapped;
     * // => true
     *
     * Array.from(wrapped);
     * // => [1, 2]
     */
    function wrapperToIterator() {
      return this;
    }

    /**
     * Creates a clone of the chain sequence planting `value` as the wrapped value.
     *
     * @name plant
     * @memberOf _
     * @since 3.2.0
     * @category Seq
     * @param {*} value The value to plant.
     * @returns {Object} Returns the new `lodash` wrapper instance.
     * @example
     *
     * function square(n) {
     *   return n * n;
     * }
     *
     * var wrapped = _([1, 2]).map(square);
     * var other = wrapped.plant([3, 4]);
     *
     * other.value();
     * // => [9, 16]
     *
     * wrapped.value();
     * // => [1, 4]
     */
    function wrapperPlant(value) {
      var result,
          parent = this;

      while (parent instanceof baseLodash) {
        var clone = wrapperClone(parent);
        clone.__index__ = 0;
        clone.__values__ = undefined;
        if (result) {
          previous.__wrapped__ = clone;
        } else {
          result = clone;
        }
        var previous = clone;
        parent = parent.__wrapped__;
      }
      previous.__wrapped__ = value;
      return result;
    }

    /**
     * This method is the wrapper version of `_.reverse`.
     *
     * **Note:** This method mutates the wrapped array.
     *
     * @name reverse
     * @memberOf _
     * @since 0.1.0
     * @category Seq
     * @returns {Object} Returns the new `lodash` wrapper instance.
     * @example
     *
     * var array = [1, 2, 3];
     *
     * _(array).reverse().value()
     * // => [3, 2, 1]
     *
     * console.log(array);
     * // => [3, 2, 1]
     */
    function wrapperReverse() {
      var value = this.__wrapped__;
      if (value instanceof LazyWrapper) {
        var wrapped = value;
        if (this.__actions__.length) {
          wrapped = new LazyWrapper(this);
        }
        wrapped = wrapped.reverse();
        wrapped.__actions__.push({
          'func': thru,
          'args': [reverse],
          'thisArg': undefined
        });
        return new LodashWrapper(wrapped, this.__chain__);
      }
      return this.thru(reverse);
    }

    /**
     * Executes the chain sequence to resolve the unwrapped value.
     *
     * @name value
     * @memberOf _
     * @since 0.1.0
     * @alias toJSON, valueOf
     * @category Seq
     * @returns {*} Returns the resolved unwrapped value.
     * @example
     *
     * _([1, 2, 3]).value();
     * // => [1, 2, 3]
     */
    function wrapperValue() {
      return baseWrapperValue(this.__wrapped__, this.__actions__);
    }

    /*------------------------------------------------------------------------*/

    /**
     * Creates an object composed of keys generated from the results of running
     * each element of `collection` thru `iteratee`. The corresponding value of
     * each key is the number of times the key was returned by `iteratee`. The
     * iteratee is invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 0.5.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The iteratee to transform keys.
     * @returns {Object} Returns the composed aggregate object.
     * @example
     *
     * _.countBy([6.1, 4.2, 6.3], Math.floor);
     * // => { '4': 1, '6': 2 }
     *
     * // The `_.property` iteratee shorthand.
     * _.countBy(['one', 'two', 'three'], 'length');
     * // => { '3': 2, '5': 1 }
     */
    var countBy = createAggregator(function(result, value, key) {
      if (hasOwnProperty.call(result, key)) {
        ++result[key];
      } else {
        baseAssignValue(result, key, 1);
      }
    });

    /**
     * Checks if `predicate` returns truthy for **all** elements of `collection`.
     * Iteration is stopped once `predicate` returns falsey. The predicate is
     * invoked with three arguments: (value, index|key, collection).
     *
     * **Note:** This method returns `true` for
     * [empty collections](https://en.wikipedia.org/wiki/Empty_set) because
     * [everything is true](https://en.wikipedia.org/wiki/Vacuous_truth) of
     * elements of empty collections.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {boolean} Returns `true` if all elements pass the predicate check,
     *  else `false`.
     * @example
     *
     * _.every([true, 1, null, 'yes'], Boolean);
     * // => false
     *
     * var users = [
     *   { 'user': 'barney', 'age': 36, 'active': false },
     *   { 'user': 'fred',   'age': 40, 'active': false }
     * ];
     *
     * // The `_.matches` iteratee shorthand.
     * _.every(users, { 'user': 'barney', 'active': false });
     * // => false
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.every(users, ['active', false]);
     * // => true
     *
     * // The `_.property` iteratee shorthand.
     * _.every(users, 'active');
     * // => false
     */
    function every(collection, predicate, guard) {
      var func = isArray(collection) ? arrayEvery : baseEvery;
      if (guard && isIterateeCall(collection, predicate, guard)) {
        predicate = undefined;
      }
      return func(collection, getIteratee(predicate, 3));
    }

    /**
     * Iterates over elements of `collection`, returning an array of all elements
     * `predicate` returns truthy for. The predicate is invoked with three
     * arguments: (value, index|key, collection).
     *
     * **Note:** Unlike `_.remove`, this method returns a new array.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the new filtered array.
     * @see _.reject
     * @example
     *
     * var users = [
     *   { 'user': 'barney', 'age': 36, 'active': true },
     *   { 'user': 'fred',   'age': 40, 'active': false }
     * ];
     *
     * _.filter(users, function(o) { return !o.active; });
     * // => objects for ['fred']
     *
     * // The `_.matches` iteratee shorthand.
     * _.filter(users, { 'age': 36, 'active': true });
     * // => objects for ['barney']
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.filter(users, ['active', false]);
     * // => objects for ['fred']
     *
     * // The `_.property` iteratee shorthand.
     * _.filter(users, 'active');
     * // => objects for ['barney']
     */
    function filter(collection, predicate) {
      var func = isArray(collection) ? arrayFilter : baseFilter;
      return func(collection, getIteratee(predicate, 3));
    }

    /**
     * Iterates over elements of `collection`, returning the first element
     * `predicate` returns truthy for. The predicate is invoked with three
     * arguments: (value, index|key, collection).
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to inspect.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @param {number} [fromIndex=0] The index to search from.
     * @returns {*} Returns the matched element, else `undefined`.
     * @example
     *
     * var users = [
     *   { 'user': 'barney',  'age': 36, 'active': true },
     *   { 'user': 'fred',    'age': 40, 'active': false },
     *   { 'user': 'pebbles', 'age': 1,  'active': true }
     * ];
     *
     * _.find(users, function(o) { return o.age < 40; });
     * // => object for 'barney'
     *
     * // The `_.matches` iteratee shorthand.
     * _.find(users, { 'age': 1, 'active': true });
     * // => object for 'pebbles'
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.find(users, ['active', false]);
     * // => object for 'fred'
     *
     * // The `_.property` iteratee shorthand.
     * _.find(users, 'active');
     * // => object for 'barney'
     */
    var find = createFind(findIndex);

    /**
     * This method is like `_.find` except that it iterates over elements of
     * `collection` from right to left.
     *
     * @static
     * @memberOf _
     * @since 2.0.0
     * @category Collection
     * @param {Array|Object} collection The collection to inspect.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @param {number} [fromIndex=collection.length-1] The index to search from.
     * @returns {*} Returns the matched element, else `undefined`.
     * @example
     *
     * _.findLast([1, 2, 3, 4], function(n) {
     *   return n % 2 == 1;
     * });
     * // => 3
     */
    var findLast = createFind(findLastIndex);

    /**
     * Creates a flattened array of values by running each element in `collection`
     * thru `iteratee` and flattening the mapped results. The iteratee is invoked
     * with three arguments: (value, index|key, collection).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the new flattened array.
     * @example
     *
     * function duplicate(n) {
     *   return [n, n];
     * }
     *
     * _.flatMap([1, 2], duplicate);
     * // => [1, 1, 2, 2]
     */
    function flatMap(collection, iteratee) {
      return baseFlatten(map(collection, iteratee), 1);
    }

    /**
     * This method is like `_.flatMap` except that it recursively flattens the
     * mapped results.
     *
     * @static
     * @memberOf _
     * @since 4.7.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the new flattened array.
     * @example
     *
     * function duplicate(n) {
     *   return [[[n, n]]];
     * }
     *
     * _.flatMapDeep([1, 2], duplicate);
     * // => [1, 1, 2, 2]
     */
    function flatMapDeep(collection, iteratee) {
      return baseFlatten(map(collection, iteratee), INFINITY);
    }

    /**
     * This method is like `_.flatMap` except that it recursively flattens the
     * mapped results up to `depth` times.
     *
     * @static
     * @memberOf _
     * @since 4.7.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @param {number} [depth=1] The maximum recursion depth.
     * @returns {Array} Returns the new flattened array.
     * @example
     *
     * function duplicate(n) {
     *   return [[[n, n]]];
     * }
     *
     * _.flatMapDepth([1, 2], duplicate, 2);
     * // => [[1, 1], [2, 2]]
     */
    function flatMapDepth(collection, iteratee, depth) {
      depth = depth === undefined ? 1 : toInteger(depth);
      return baseFlatten(map(collection, iteratee), depth);
    }

    /**
     * Iterates over elements of `collection` and invokes `iteratee` for each element.
     * The iteratee is invoked with three arguments: (value, index|key, collection).
     * Iteratee functions may exit iteration early by explicitly returning `false`.
     *
     * **Note:** As with other "Collections" methods, objects with a "length"
     * property are iterated like arrays. To avoid this behavior use `_.forIn`
     * or `_.forOwn` for object iteration.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @alias each
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Array|Object} Returns `collection`.
     * @see _.forEachRight
     * @example
     *
     * _.forEach([1, 2], function(value) {
     *   console.log(value);
     * });
     * // => Logs `1` then `2`.
     *
     * _.forEach({ 'a': 1, 'b': 2 }, function(value, key) {
     *   console.log(key);
     * });
     * // => Logs 'a' then 'b' (iteration order is not guaranteed).
     */
    function forEach(collection, iteratee) {
      var func = isArray(collection) ? arrayEach : baseEach;
      return func(collection, getIteratee(iteratee, 3));
    }

    /**
     * This method is like `_.forEach` except that it iterates over elements of
     * `collection` from right to left.
     *
     * @static
     * @memberOf _
     * @since 2.0.0
     * @alias eachRight
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Array|Object} Returns `collection`.
     * @see _.forEach
     * @example
     *
     * _.forEachRight([1, 2], function(value) {
     *   console.log(value);
     * });
     * // => Logs `2` then `1`.
     */
    function forEachRight(collection, iteratee) {
      var func = isArray(collection) ? arrayEachRight : baseEachRight;
      return func(collection, getIteratee(iteratee, 3));
    }

    /**
     * Creates an object composed of keys generated from the results of running
     * each element of `collection` thru `iteratee`. The order of grouped values
     * is determined by the order they occur in `collection`. The corresponding
     * value of each key is an array of elements responsible for generating the
     * key. The iteratee is invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The iteratee to transform keys.
     * @returns {Object} Returns the composed aggregate object.
     * @example
     *
     * _.groupBy([6.1, 4.2, 6.3], Math.floor);
     * // => { '4': [4.2], '6': [6.1, 6.3] }
     *
     * // The `_.property` iteratee shorthand.
     * _.groupBy(['one', 'two', 'three'], 'length');
     * // => { '3': ['one', 'two'], '5': ['three'] }
     */
    var groupBy = createAggregator(function(result, value, key) {
      if (hasOwnProperty.call(result, key)) {
        result[key].push(value);
      } else {
        baseAssignValue(result, key, [value]);
      }
    });

    /**
     * Checks if `value` is in `collection`. If `collection` is a string, it's
     * checked for a substring of `value`, otherwise
     * [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
     * is used for equality comparisons. If `fromIndex` is negative, it's used as
     * the offset from the end of `collection`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object|string} collection The collection to inspect.
     * @param {*} value The value to search for.
     * @param {number} [fromIndex=0] The index to search from.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.reduce`.
     * @returns {boolean} Returns `true` if `value` is found, else `false`.
     * @example
     *
     * _.includes([1, 2, 3], 1);
     * // => true
     *
     * _.includes([1, 2, 3], 1, 2);
     * // => false
     *
     * _.includes({ 'a': 1, 'b': 2 }, 1);
     * // => true
     *
     * _.includes('abcd', 'bc');
     * // => true
     */
    function includes(collection, value, fromIndex, guard) {
      collection = isArrayLike(collection) ? collection : values(collection);
      fromIndex = (fromIndex && !guard) ? toInteger(fromIndex) : 0;

      var length = collection.length;
      if (fromIndex < 0) {
        fromIndex = nativeMax(length + fromIndex, 0);
      }
      return isString(collection)
        ? (fromIndex <= length && collection.indexOf(value, fromIndex) > -1)
        : (!!length && baseIndexOf(collection, value, fromIndex) > -1);
    }

    /**
     * Invokes the method at `path` of each element in `collection`, returning
     * an array of the results of each invoked method. Any additional arguments
     * are provided to each invoked method. If `path` is a function, it's invoked
     * for, and `this` bound to, each element in `collection`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Array|Function|string} path The path of the method to invoke or
     *  the function invoked per iteration.
     * @param {...*} [args] The arguments to invoke each method with.
     * @returns {Array} Returns the array of results.
     * @example
     *
     * _.invokeMap([[5, 1, 7], [3, 2, 1]], 'sort');
     * // => [[1, 5, 7], [1, 2, 3]]
     *
     * _.invokeMap([123, 456], String.prototype.split, '');
     * // => [['1', '2', '3'], ['4', '5', '6']]
     */
    var invokeMap = baseRest(function(collection, path, args) {
      var index = -1,
          isFunc = typeof path == 'function',
          result = isArrayLike(collection) ? Array(collection.length) : [];

      baseEach(collection, function(value) {
        result[++index] = isFunc ? apply(path, value, args) : baseInvoke(value, path, args);
      });
      return result;
    });

    /**
     * Creates an object composed of keys generated from the results of running
     * each element of `collection` thru `iteratee`. The corresponding value of
     * each key is the last element responsible for generating the key. The
     * iteratee is invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The iteratee to transform keys.
     * @returns {Object} Returns the composed aggregate object.
     * @example
     *
     * var array = [
     *   { 'dir': 'left', 'code': 97 },
     *   { 'dir': 'right', 'code': 100 }
     * ];
     *
     * _.keyBy(array, function(o) {
     *   return String.fromCharCode(o.code);
     * });
     * // => { 'a': { 'dir': 'left', 'code': 97 }, 'd': { 'dir': 'right', 'code': 100 } }
     *
     * _.keyBy(array, 'dir');
     * // => { 'left': { 'dir': 'left', 'code': 97 }, 'right': { 'dir': 'right', 'code': 100 } }
     */
    var keyBy = createAggregator(function(result, value, key) {
      baseAssignValue(result, key, value);
    });

    /**
     * Creates an array of values by running each element in `collection` thru
     * `iteratee`. The iteratee is invoked with three arguments:
     * (value, index|key, collection).
     *
     * Many lodash methods are guarded to work as iteratees for methods like
     * `_.every`, `_.filter`, `_.map`, `_.mapValues`, `_.reject`, and `_.some`.
     *
     * The guarded methods are:
     * `ary`, `chunk`, `curry`, `curryRight`, `drop`, `dropRight`, `every`,
     * `fill`, `invert`, `parseInt`, `random`, `range`, `rangeRight`, `repeat`,
     * `sampleSize`, `slice`, `some`, `sortBy`, `split`, `take`, `takeRight`,
     * `template`, `trim`, `trimEnd`, `trimStart`, and `words`
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the new mapped array.
     * @example
     *
     * function square(n) {
     *   return n * n;
     * }
     *
     * _.map([4, 8], square);
     * // => [16, 64]
     *
     * _.map({ 'a': 4, 'b': 8 }, square);
     * // => [16, 64] (iteration order is not guaranteed)
     *
     * var users = [
     *   { 'user': 'barney' },
     *   { 'user': 'fred' }
     * ];
     *
     * // The `_.property` iteratee shorthand.
     * _.map(users, 'user');
     * // => ['barney', 'fred']
     */
    function map(collection, iteratee) {
      var func = isArray(collection) ? arrayMap : baseMap;
      return func(collection, getIteratee(iteratee, 3));
    }

    /**
     * This method is like `_.sortBy` except that it allows specifying the sort
     * orders of the iteratees to sort by. If `orders` is unspecified, all values
     * are sorted in ascending order. Otherwise, specify an order of "desc" for
     * descending or "asc" for ascending sort order of corresponding values.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Array[]|Function[]|Object[]|string[]} [iteratees=[_.identity]]
     *  The iteratees to sort by.
     * @param {string[]} [orders] The sort orders of `iteratees`.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.reduce`.
     * @returns {Array} Returns the new sorted array.
     * @example
     *
     * var users = [
     *   { 'user': 'fred',   'age': 48 },
     *   { 'user': 'barney', 'age': 34 },
     *   { 'user': 'fred',   'age': 40 },
     *   { 'user': 'barney', 'age': 36 }
     * ];
     *
     * // Sort by `user` in ascending order and by `age` in descending order.
     * _.orderBy(users, ['user', 'age'], ['asc', 'desc']);
     * // => objects for [['barney', 36], ['barney', 34], ['fred', 48], ['fred', 40]]
     */
    function orderBy(collection, iteratees, orders, guard) {
      if (collection == null) {
        return [];
      }
      if (!isArray(iteratees)) {
        iteratees = iteratees == null ? [] : [iteratees];
      }
      orders = guard ? undefined : orders;
      if (!isArray(orders)) {
        orders = orders == null ? [] : [orders];
      }
      return baseOrderBy(collection, iteratees, orders);
    }

    /**
     * Creates an array of elements split into two groups, the first of which
     * contains elements `predicate` returns truthy for, the second of which
     * contains elements `predicate` returns falsey for. The predicate is
     * invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the array of grouped elements.
     * @example
     *
     * var users = [
     *   { 'user': 'barney',  'age': 36, 'active': false },
     *   { 'user': 'fred',    'age': 40, 'active': true },
     *   { 'user': 'pebbles', 'age': 1,  'active': false }
     * ];
     *
     * _.partition(users, function(o) { return o.active; });
     * // => objects for [['fred'], ['barney', 'pebbles']]
     *
     * // The `_.matches` iteratee shorthand.
     * _.partition(users, { 'age': 1, 'active': false });
     * // => objects for [['pebbles'], ['barney', 'fred']]
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.partition(users, ['active', false]);
     * // => objects for [['barney', 'pebbles'], ['fred']]
     *
     * // The `_.property` iteratee shorthand.
     * _.partition(users, 'active');
     * // => objects for [['fred'], ['barney', 'pebbles']]
     */
    var partition = createAggregator(function(result, value, key) {
      result[key ? 0 : 1].push(value);
    }, function() { return [[], []]; });

    /**
     * Reduces `collection` to a value which is the accumulated result of running
     * each element in `collection` thru `iteratee`, where each successive
     * invocation is supplied the return value of the previous. If `accumulator`
     * is not given, the first element of `collection` is used as the initial
     * value. The iteratee is invoked with four arguments:
     * (accumulator, value, index|key, collection).
     *
     * Many lodash methods are guarded to work as iteratees for methods like
     * `_.reduce`, `_.reduceRight`, and `_.transform`.
     *
     * The guarded methods are:
     * `assign`, `defaults`, `defaultsDeep`, `includes`, `merge`, `orderBy`,
     * and `sortBy`
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @param {*} [accumulator] The initial value.
     * @returns {*} Returns the accumulated value.
     * @see _.reduceRight
     * @example
     *
     * _.reduce([1, 2], function(sum, n) {
     *   return sum + n;
     * }, 0);
     * // => 3
     *
     * _.reduce({ 'a': 1, 'b': 2, 'c': 1 }, function(result, value, key) {
     *   (result[value] || (result[value] = [])).push(key);
     *   return result;
     * }, {});
     * // => { '1': ['a', 'c'], '2': ['b'] } (iteration order is not guaranteed)
     */
    function reduce(collection, iteratee, accumulator) {
      var func = isArray(collection) ? arrayReduce : baseReduce,
          initAccum = arguments.length < 3;

      return func(collection, getIteratee(iteratee, 4), accumulator, initAccum, baseEach);
    }

    /**
     * This method is like `_.reduce` except that it iterates over elements of
     * `collection` from right to left.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @param {*} [accumulator] The initial value.
     * @returns {*} Returns the accumulated value.
     * @see _.reduce
     * @example
     *
     * var array = [[0, 1], [2, 3], [4, 5]];
     *
     * _.reduceRight(array, function(flattened, other) {
     *   return flattened.concat(other);
     * }, []);
     * // => [4, 5, 2, 3, 0, 1]
     */
    function reduceRight(collection, iteratee, accumulator) {
      var func = isArray(collection) ? arrayReduceRight : baseReduce,
          initAccum = arguments.length < 3;

      return func(collection, getIteratee(iteratee, 4), accumulator, initAccum, baseEachRight);
    }

    /**
     * The opposite of `_.filter`; this method returns the elements of `collection`
     * that `predicate` does **not** return truthy for.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the new filtered array.
     * @see _.filter
     * @example
     *
     * var users = [
     *   { 'user': 'barney', 'age': 36, 'active': false },
     *   { 'user': 'fred',   'age': 40, 'active': true }
     * ];
     *
     * _.reject(users, function(o) { return !o.active; });
     * // => objects for ['fred']
     *
     * // The `_.matches` iteratee shorthand.
     * _.reject(users, { 'age': 40, 'active': true });
     * // => objects for ['barney']
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.reject(users, ['active', false]);
     * // => objects for ['fred']
     *
     * // The `_.property` iteratee shorthand.
     * _.reject(users, 'active');
     * // => objects for ['barney']
     */
    function reject(collection, predicate) {
      var func = isArray(collection) ? arrayFilter : baseFilter;
      return func(collection, negate(getIteratee(predicate, 3)));
    }

    /**
     * Gets a random element from `collection`.
     *
     * @static
     * @memberOf _
     * @since 2.0.0
     * @category Collection
     * @param {Array|Object} collection The collection to sample.
     * @returns {*} Returns the random element.
     * @example
     *
     * _.sample([1, 2, 3, 4]);
     * // => 2
     */
    function sample(collection) {
      var func = isArray(collection) ? arraySample : baseSample;
      return func(collection);
    }

    /**
     * Gets `n` random elements at unique keys from `collection` up to the
     * size of `collection`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Collection
     * @param {Array|Object} collection The collection to sample.
     * @param {number} [n=1] The number of elements to sample.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Array} Returns the random elements.
     * @example
     *
     * _.sampleSize([1, 2, 3], 2);
     * // => [3, 1]
     *
     * _.sampleSize([1, 2, 3], 4);
     * // => [2, 3, 1]
     */
    function sampleSize(collection, n, guard) {
      if ((guard ? isIterateeCall(collection, n, guard) : n === undefined)) {
        n = 1;
      } else {
        n = toInteger(n);
      }
      var func = isArray(collection) ? arraySampleSize : baseSampleSize;
      return func(collection, n);
    }

    /**
     * Creates an array of shuffled values, using a version of the
     * [Fisher-Yates shuffle](https://en.wikipedia.org/wiki/Fisher-Yates_shuffle).
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to shuffle.
     * @returns {Array} Returns the new shuffled array.
     * @example
     *
     * _.shuffle([1, 2, 3, 4]);
     * // => [4, 1, 3, 2]
     */
    function shuffle(collection) {
      var func = isArray(collection) ? arrayShuffle : baseShuffle;
      return func(collection);
    }

    /**
     * Gets the size of `collection` by returning its length for array-like
     * values or the number of own enumerable string keyed properties for objects.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object|string} collection The collection to inspect.
     * @returns {number} Returns the collection size.
     * @example
     *
     * _.size([1, 2, 3]);
     * // => 3
     *
     * _.size({ 'a': 1, 'b': 2 });
     * // => 2
     *
     * _.size('pebbles');
     * // => 7
     */
    function size(collection) {
      if (collection == null) {
        return 0;
      }
      if (isArrayLike(collection)) {
        return isString(collection) ? stringSize(collection) : collection.length;
      }
      var tag = getTag(collection);
      if (tag == mapTag || tag == setTag) {
        return collection.size;
      }
      return baseKeys(collection).length;
    }

    /**
     * Checks if `predicate` returns truthy for **any** element of `collection`.
     * Iteration is stopped once `predicate` returns truthy. The predicate is
     * invoked with three arguments: (value, index|key, collection).
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {boolean} Returns `true` if any element passes the predicate check,
     *  else `false`.
     * @example
     *
     * _.some([null, 0, 'yes', false], Boolean);
     * // => true
     *
     * var users = [
     *   { 'user': 'barney', 'active': true },
     *   { 'user': 'fred',   'active': false }
     * ];
     *
     * // The `_.matches` iteratee shorthand.
     * _.some(users, { 'user': 'barney', 'active': false });
     * // => false
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.some(users, ['active', false]);
     * // => true
     *
     * // The `_.property` iteratee shorthand.
     * _.some(users, 'active');
     * // => true
     */
    function some(collection, predicate, guard) {
      var func = isArray(collection) ? arraySome : baseSome;
      if (guard && isIterateeCall(collection, predicate, guard)) {
        predicate = undefined;
      }
      return func(collection, getIteratee(predicate, 3));
    }

    /**
     * Creates an array of elements, sorted in ascending order by the results of
     * running each element in a collection thru each iteratee. This method
     * performs a stable sort, that is, it preserves the original sort order of
     * equal elements. The iteratees are invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Collection
     * @param {Array|Object} collection The collection to iterate over.
     * @param {...(Function|Function[])} [iteratees=[_.identity]]
     *  The iteratees to sort by.
     * @returns {Array} Returns the new sorted array.
     * @example
     *
     * var users = [
     *   { 'user': 'fred',   'age': 48 },
     *   { 'user': 'barney', 'age': 36 },
     *   { 'user': 'fred',   'age': 40 },
     *   { 'user': 'barney', 'age': 34 }
     * ];
     *
     * _.sortBy(users, [function(o) { return o.user; }]);
     * // => objects for [['barney', 36], ['barney', 34], ['fred', 48], ['fred', 40]]
     *
     * _.sortBy(users, ['user', 'age']);
     * // => objects for [['barney', 34], ['barney', 36], ['fred', 40], ['fred', 48]]
     */
    var sortBy = baseRest(function(collection, iteratees) {
      if (collection == null) {
        return [];
      }
      var length = iteratees.length;
      if (length > 1 && isIterateeCall(collection, iteratees[0], iteratees[1])) {
        iteratees = [];
      } else if (length > 2 && isIterateeCall(iteratees[0], iteratees[1], iteratees[2])) {
        iteratees = [iteratees[0]];
      }
      return baseOrderBy(collection, baseFlatten(iteratees, 1), []);
    });

    /*------------------------------------------------------------------------*/

    /**
     * Gets the timestamp of the number of milliseconds that have elapsed since
     * the Unix epoch (1 January 1970 00:00:00 UTC).
     *
     * @static
     * @memberOf _
     * @since 2.4.0
     * @category Date
     * @returns {number} Returns the timestamp.
     * @example
     *
     * _.defer(function(stamp) {
     *   console.log(_.now() - stamp);
     * }, _.now());
     * // => Logs the number of milliseconds it took for the deferred invocation.
     */
    var now = ctxNow || function() {
      return root.Date.now();
    };

    /*------------------------------------------------------------------------*/

    /**
     * The opposite of `_.before`; this method creates a function that invokes
     * `func` once it's called `n` or more times.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Function
     * @param {number} n The number of calls before `func` is invoked.
     * @param {Function} func The function to restrict.
     * @returns {Function} Returns the new restricted function.
     * @example
     *
     * var saves = ['profile', 'settings'];
     *
     * var done = _.after(saves.length, function() {
     *   console.log('done saving!');
     * });
     *
     * _.forEach(saves, function(type) {
     *   asyncSave({ 'type': type, 'complete': done });
     * });
     * // => Logs 'done saving!' after the two async saves have completed.
     */
    function after(n, func) {
      if (typeof func != 'function') {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      n = toInteger(n);
      return function() {
        if (--n < 1) {
          return func.apply(this, arguments);
        }
      };
    }

    /**
     * Creates a function that invokes `func`, with up to `n` arguments,
     * ignoring any additional arguments.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Function
     * @param {Function} func The function to cap arguments for.
     * @param {number} [n=func.length] The arity cap.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Function} Returns the new capped function.
     * @example
     *
     * _.map(['6', '8', '10'], _.ary(parseInt, 1));
     * // => [6, 8, 10]
     */
    function ary(func, n, guard) {
      n = guard ? undefined : n;
      n = (func && n == null) ? func.length : n;
      return createWrap(func, WRAP_ARY_FLAG, undefined, undefined, undefined, undefined, n);
    }

    /**
     * Creates a function that invokes `func`, with the `this` binding and arguments
     * of the created function, while it's called less than `n` times. Subsequent
     * calls to the created function return the result of the last `func` invocation.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Function
     * @param {number} n The number of calls at which `func` is no longer invoked.
     * @param {Function} func The function to restrict.
     * @returns {Function} Returns the new restricted function.
     * @example
     *
     * jQuery(element).on('click', _.before(5, addContactToList));
     * // => Allows adding up to 4 contacts to the list.
     */
    function before(n, func) {
      var result;
      if (typeof func != 'function') {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      n = toInteger(n);
      return function() {
        if (--n > 0) {
          result = func.apply(this, arguments);
        }
        if (n <= 1) {
          func = undefined;
        }
        return result;
      };
    }

    /**
     * Creates a function that invokes `func` with the `this` binding of `thisArg`
     * and `partials` prepended to the arguments it receives.
     *
     * The `_.bind.placeholder` value, which defaults to `_` in monolithic builds,
     * may be used as a placeholder for partially applied arguments.
     *
     * **Note:** Unlike native `Function#bind`, this method doesn't set the "length"
     * property of bound functions.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Function
     * @param {Function} func The function to bind.
     * @param {*} thisArg The `this` binding of `func`.
     * @param {...*} [partials] The arguments to be partially applied.
     * @returns {Function} Returns the new bound function.
     * @example
     *
     * function greet(greeting, punctuation) {
     *   return greeting + ' ' + this.user + punctuation;
     * }
     *
     * var object = { 'user': 'fred' };
     *
     * var bound = _.bind(greet, object, 'hi');
     * bound('!');
     * // => 'hi fred!'
     *
     * // Bound with placeholders.
     * var bound = _.bind(greet, object, _, '!');
     * bound('hi');
     * // => 'hi fred!'
     */
    var bind = baseRest(function(func, thisArg, partials) {
      var bitmask = WRAP_BIND_FLAG;
      if (partials.length) {
        var holders = replaceHolders(partials, getHolder(bind));
        bitmask |= WRAP_PARTIAL_FLAG;
      }
      return createWrap(func, bitmask, thisArg, partials, holders);
    });

    /**
     * Creates a function that invokes the method at `object[key]` with `partials`
     * prepended to the arguments it receives.
     *
     * This method differs from `_.bind` by allowing bound functions to reference
     * methods that may be redefined or don't yet exist. See
     * [Peter Michaux's article](http://peter.michaux.ca/articles/lazy-function-definition-pattern)
     * for more details.
     *
     * The `_.bindKey.placeholder` value, which defaults to `_` in monolithic
     * builds, may be used as a placeholder for partially applied arguments.
     *
     * @static
     * @memberOf _
     * @since 0.10.0
     * @category Function
     * @param {Object} object The object to invoke the method on.
     * @param {string} key The key of the method.
     * @param {...*} [partials] The arguments to be partially applied.
     * @returns {Function} Returns the new bound function.
     * @example
     *
     * var object = {
     *   'user': 'fred',
     *   'greet': function(greeting, punctuation) {
     *     return greeting + ' ' + this.user + punctuation;
     *   }
     * };
     *
     * var bound = _.bindKey(object, 'greet', 'hi');
     * bound('!');
     * // => 'hi fred!'
     *
     * object.greet = function(greeting, punctuation) {
     *   return greeting + 'ya ' + this.user + punctuation;
     * };
     *
     * bound('!');
     * // => 'hiya fred!'
     *
     * // Bound with placeholders.
     * var bound = _.bindKey(object, 'greet', _, '!');
     * bound('hi');
     * // => 'hiya fred!'
     */
    var bindKey = baseRest(function(object, key, partials) {
      var bitmask = WRAP_BIND_FLAG | WRAP_BIND_KEY_FLAG;
      if (partials.length) {
        var holders = replaceHolders(partials, getHolder(bindKey));
        bitmask |= WRAP_PARTIAL_FLAG;
      }
      return createWrap(key, bitmask, object, partials, holders);
    });

    /**
     * Creates a function that accepts arguments of `func` and either invokes
     * `func` returning its result, if at least `arity` number of arguments have
     * been provided, or returns a function that accepts the remaining `func`
     * arguments, and so on. The arity of `func` may be specified if `func.length`
     * is not sufficient.
     *
     * The `_.curry.placeholder` value, which defaults to `_` in monolithic builds,
     * may be used as a placeholder for provided arguments.
     *
     * **Note:** This method doesn't set the "length" property of curried functions.
     *
     * @static
     * @memberOf _
     * @since 2.0.0
     * @category Function
     * @param {Function} func The function to curry.
     * @param {number} [arity=func.length] The arity of `func`.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Function} Returns the new curried function.
     * @example
     *
     * var abc = function(a, b, c) {
     *   return [a, b, c];
     * };
     *
     * var curried = _.curry(abc);
     *
     * curried(1)(2)(3);
     * // => [1, 2, 3]
     *
     * curried(1, 2)(3);
     * // => [1, 2, 3]
     *
     * curried(1, 2, 3);
     * // => [1, 2, 3]
     *
     * // Curried with placeholders.
     * curried(1)(_, 3)(2);
     * // => [1, 2, 3]
     */
    function curry(func, arity, guard) {
      arity = guard ? undefined : arity;
      var result = createWrap(func, WRAP_CURRY_FLAG, undefined, undefined, undefined, undefined, undefined, arity);
      result.placeholder = curry.placeholder;
      return result;
    }

    /**
     * This method is like `_.curry` except that arguments are applied to `func`
     * in the manner of `_.partialRight` instead of `_.partial`.
     *
     * The `_.curryRight.placeholder` value, which defaults to `_` in monolithic
     * builds, may be used as a placeholder for provided arguments.
     *
     * **Note:** This method doesn't set the "length" property of curried functions.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Function
     * @param {Function} func The function to curry.
     * @param {number} [arity=func.length] The arity of `func`.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Function} Returns the new curried function.
     * @example
     *
     * var abc = function(a, b, c) {
     *   return [a, b, c];
     * };
     *
     * var curried = _.curryRight(abc);
     *
     * curried(3)(2)(1);
     * // => [1, 2, 3]
     *
     * curried(2, 3)(1);
     * // => [1, 2, 3]
     *
     * curried(1, 2, 3);
     * // => [1, 2, 3]
     *
     * // Curried with placeholders.
     * curried(3)(1, _)(2);
     * // => [1, 2, 3]
     */
    function curryRight(func, arity, guard) {
      arity = guard ? undefined : arity;
      var result = createWrap(func, WRAP_CURRY_RIGHT_FLAG, undefined, undefined, undefined, undefined, undefined, arity);
      result.placeholder = curryRight.placeholder;
      return result;
    }

    /**
     * Creates a debounced function that delays invoking `func` until after `wait`
     * milliseconds have elapsed since the last time the debounced function was
     * invoked. The debounced function comes with a `cancel` method to cancel
     * delayed `func` invocations and a `flush` method to immediately invoke them.
     * Provide `options` to indicate whether `func` should be invoked on the
     * leading and/or trailing edge of the `wait` timeout. The `func` is invoked
     * with the last arguments provided to the debounced function. Subsequent
     * calls to the debounced function return the result of the last `func`
     * invocation.
     *
     * **Note:** If `leading` and `trailing` options are `true`, `func` is
     * invoked on the trailing edge of the timeout only if the debounced function
     * is invoked more than once during the `wait` timeout.
     *
     * If `wait` is `0` and `leading` is `false`, `func` invocation is deferred
     * until to the next tick, similar to `setTimeout` with a timeout of `0`.
     *
     * See [David Corbacho's article](https://css-tricks.com/debouncing-throttling-explained-examples/)
     * for details over the differences between `_.debounce` and `_.throttle`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Function
     * @param {Function} func The function to debounce.
     * @param {number} [wait=0] The number of milliseconds to delay.
     * @param {Object} [options={}] The options object.
     * @param {boolean} [options.leading=false]
     *  Specify invoking on the leading edge of the timeout.
     * @param {number} [options.maxWait]
     *  The maximum time `func` is allowed to be delayed before it's invoked.
     * @param {boolean} [options.trailing=true]
     *  Specify invoking on the trailing edge of the timeout.
     * @returns {Function} Returns the new debounced function.
     * @example
     *
     * // Avoid costly calculations while the window size is in flux.
     * jQuery(window).on('resize', _.debounce(calculateLayout, 150));
     *
     * // Invoke `sendMail` when clicked, debouncing subsequent calls.
     * jQuery(element).on('click', _.debounce(sendMail, 300, {
     *   'leading': true,
     *   'trailing': false
     * }));
     *
     * // Ensure `batchLog` is invoked once after 1 second of debounced calls.
     * var debounced = _.debounce(batchLog, 250, { 'maxWait': 1000 });
     * var source = new EventSource('/stream');
     * jQuery(source).on('message', debounced);
     *
     * // Cancel the trailing debounced invocation.
     * jQuery(window).on('popstate', debounced.cancel);
     */
    function debounce(func, wait, options) {
      var lastArgs,
          lastThis,
          maxWait,
          result,
          timerId,
          lastCallTime,
          lastInvokeTime = 0,
          leading = false,
          maxing = false,
          trailing = true;

      if (typeof func != 'function') {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      wait = toNumber(wait) || 0;
      if (isObject(options)) {
        leading = !!options.leading;
        maxing = 'maxWait' in options;
        maxWait = maxing ? nativeMax(toNumber(options.maxWait) || 0, wait) : maxWait;
        trailing = 'trailing' in options ? !!options.trailing : trailing;
      }

      function invokeFunc(time) {
        var args = lastArgs,
            thisArg = lastThis;

        lastArgs = lastThis = undefined;
        lastInvokeTime = time;
        result = func.apply(thisArg, args);
        return result;
      }

      function leadingEdge(time) {
        // Reset any `maxWait` timer.
        lastInvokeTime = time;
        // Start the timer for the trailing edge.
        timerId = setTimeout(timerExpired, wait);
        // Invoke the leading edge.
        return leading ? invokeFunc(time) : result;
      }

      function remainingWait(time) {
        var timeSinceLastCall = time - lastCallTime,
            timeSinceLastInvoke = time - lastInvokeTime,
            result = wait - timeSinceLastCall;

        return maxing ? nativeMin(result, maxWait - timeSinceLastInvoke) : result;
      }

      function shouldInvoke(time) {
        var timeSinceLastCall = time - lastCallTime,
            timeSinceLastInvoke = time - lastInvokeTime;

        // Either this is the first call, activity has stopped and we're at the
        // trailing edge, the system time has gone backwards and we're treating
        // it as the trailing edge, or we've hit the `maxWait` limit.
        return (lastCallTime === undefined || (timeSinceLastCall >= wait) ||
          (timeSinceLastCall < 0) || (maxing && timeSinceLastInvoke >= maxWait));
      }

      function timerExpired() {
        var time = now();
        if (shouldInvoke(time)) {
          return trailingEdge(time);
        }
        // Restart the timer.
        timerId = setTimeout(timerExpired, remainingWait(time));
      }

      function trailingEdge(time) {
        timerId = undefined;

        // Only invoke if we have `lastArgs` which means `func` has been
        // debounced at least once.
        if (trailing && lastArgs) {
          return invokeFunc(time);
        }
        lastArgs = lastThis = undefined;
        return result;
      }

      function cancel() {
        if (timerId !== undefined) {
          clearTimeout(timerId);
        }
        lastInvokeTime = 0;
        lastArgs = lastCallTime = lastThis = timerId = undefined;
      }

      function flush() {
        return timerId === undefined ? result : trailingEdge(now());
      }

      function debounced() {
        var time = now(),
            isInvoking = shouldInvoke(time);

        lastArgs = arguments;
        lastThis = this;
        lastCallTime = time;

        if (isInvoking) {
          if (timerId === undefined) {
            return leadingEdge(lastCallTime);
          }
          if (maxing) {
            // Handle invocations in a tight loop.
            timerId = setTimeout(timerExpired, wait);
            return invokeFunc(lastCallTime);
          }
        }
        if (timerId === undefined) {
          timerId = setTimeout(timerExpired, wait);
        }
        return result;
      }
      debounced.cancel = cancel;
      debounced.flush = flush;
      return debounced;
    }

    /**
     * Defers invoking the `func` until the current call stack has cleared. Any
     * additional arguments are provided to `func` when it's invoked.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Function
     * @param {Function} func The function to defer.
     * @param {...*} [args] The arguments to invoke `func` with.
     * @returns {number} Returns the timer id.
     * @example
     *
     * _.defer(function(text) {
     *   console.log(text);
     * }, 'deferred');
     * // => Logs 'deferred' after one millisecond.
     */
    var defer = baseRest(function(func, args) {
      return baseDelay(func, 1, args);
    });

    /**
     * Invokes `func` after `wait` milliseconds. Any additional arguments are
     * provided to `func` when it's invoked.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Function
     * @param {Function} func The function to delay.
     * @param {number} wait The number of milliseconds to delay invocation.
     * @param {...*} [args] The arguments to invoke `func` with.
     * @returns {number} Returns the timer id.
     * @example
     *
     * _.delay(function(text) {
     *   console.log(text);
     * }, 1000, 'later');
     * // => Logs 'later' after one second.
     */
    var delay = baseRest(function(func, wait, args) {
      return baseDelay(func, toNumber(wait) || 0, args);
    });

    /**
     * Creates a function that invokes `func` with arguments reversed.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Function
     * @param {Function} func The function to flip arguments for.
     * @returns {Function} Returns the new flipped function.
     * @example
     *
     * var flipped = _.flip(function() {
     *   return _.toArray(arguments);
     * });
     *
     * flipped('a', 'b', 'c', 'd');
     * // => ['d', 'c', 'b', 'a']
     */
    function flip(func) {
      return createWrap(func, WRAP_FLIP_FLAG);
    }

    /**
     * Creates a function that memoizes the result of `func`. If `resolver` is
     * provided, it determines the cache key for storing the result based on the
     * arguments provided to the memoized function. By default, the first argument
     * provided to the memoized function is used as the map cache key. The `func`
     * is invoked with the `this` binding of the memoized function.
     *
     * **Note:** The cache is exposed as the `cache` property on the memoized
     * function. Its creation may be customized by replacing the `_.memoize.Cache`
     * constructor with one whose instances implement the
     * [`Map`](http://ecma-international.org/ecma-262/7.0/#sec-properties-of-the-map-prototype-object)
     * method interface of `clear`, `delete`, `get`, `has`, and `set`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Function
     * @param {Function} func The function to have its output memoized.
     * @param {Function} [resolver] The function to resolve the cache key.
     * @returns {Function} Returns the new memoized function.
     * @example
     *
     * var object = { 'a': 1, 'b': 2 };
     * var other = { 'c': 3, 'd': 4 };
     *
     * var values = _.memoize(_.values);
     * values(object);
     * // => [1, 2]
     *
     * values(other);
     * // => [3, 4]
     *
     * object.a = 2;
     * values(object);
     * // => [1, 2]
     *
     * // Modify the result cache.
     * values.cache.set(object, ['a', 'b']);
     * values(object);
     * // => ['a', 'b']
     *
     * // Replace `_.memoize.Cache`.
     * _.memoize.Cache = WeakMap;
     */
    function memoize(func, resolver) {
      if (typeof func != 'function' || (resolver != null && typeof resolver != 'function')) {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      var memoized = function() {
        var args = arguments,
            key = resolver ? resolver.apply(this, args) : args[0],
            cache = memoized.cache;

        if (cache.has(key)) {
          return cache.get(key);
        }
        var result = func.apply(this, args);
        memoized.cache = cache.set(key, result) || cache;
        return result;
      };
      memoized.cache = new (memoize.Cache || MapCache);
      return memoized;
    }

    // Expose `MapCache`.
    memoize.Cache = MapCache;

    /**
     * Creates a function that negates the result of the predicate `func`. The
     * `func` predicate is invoked with the `this` binding and arguments of the
     * created function.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Function
     * @param {Function} predicate The predicate to negate.
     * @returns {Function} Returns the new negated function.
     * @example
     *
     * function isEven(n) {
     *   return n % 2 == 0;
     * }
     *
     * _.filter([1, 2, 3, 4, 5, 6], _.negate(isEven));
     * // => [1, 3, 5]
     */
    function negate(predicate) {
      if (typeof predicate != 'function') {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      return function() {
        var args = arguments;
        switch (args.length) {
          case 0: return !predicate.call(this);
          case 1: return !predicate.call(this, args[0]);
          case 2: return !predicate.call(this, args[0], args[1]);
          case 3: return !predicate.call(this, args[0], args[1], args[2]);
        }
        return !predicate.apply(this, args);
      };
    }

    /**
     * Creates a function that is restricted to invoking `func` once. Repeat calls
     * to the function return the value of the first invocation. The `func` is
     * invoked with the `this` binding and arguments of the created function.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Function
     * @param {Function} func The function to restrict.
     * @returns {Function} Returns the new restricted function.
     * @example
     *
     * var initialize = _.once(createApplication);
     * initialize();
     * initialize();
     * // => `createApplication` is invoked once
     */
    function once(func) {
      return before(2, func);
    }

    /**
     * Creates a function that invokes `func` with its arguments transformed.
     *
     * @static
     * @since 4.0.0
     * @memberOf _
     * @category Function
     * @param {Function} func The function to wrap.
     * @param {...(Function|Function[])} [transforms=[_.identity]]
     *  The argument transforms.
     * @returns {Function} Returns the new function.
     * @example
     *
     * function doubled(n) {
     *   return n * 2;
     * }
     *
     * function square(n) {
     *   return n * n;
     * }
     *
     * var func = _.overArgs(function(x, y) {
     *   return [x, y];
     * }, [square, doubled]);
     *
     * func(9, 3);
     * // => [81, 6]
     *
     * func(10, 5);
     * // => [100, 10]
     */
    var overArgs = castRest(function(func, transforms) {
      transforms = (transforms.length == 1 && isArray(transforms[0]))
        ? arrayMap(transforms[0], baseUnary(getIteratee()))
        : arrayMap(baseFlatten(transforms, 1), baseUnary(getIteratee()));

      var funcsLength = transforms.length;
      return baseRest(function(args) {
        var index = -1,
            length = nativeMin(args.length, funcsLength);

        while (++index < length) {
          args[index] = transforms[index].call(this, args[index]);
        }
        return apply(func, this, args);
      });
    });

    /**
     * Creates a function that invokes `func` with `partials` prepended to the
     * arguments it receives. This method is like `_.bind` except it does **not**
     * alter the `this` binding.
     *
     * The `_.partial.placeholder` value, which defaults to `_` in monolithic
     * builds, may be used as a placeholder for partially applied arguments.
     *
     * **Note:** This method doesn't set the "length" property of partially
     * applied functions.
     *
     * @static
     * @memberOf _
     * @since 0.2.0
     * @category Function
     * @param {Function} func The function to partially apply arguments to.
     * @param {...*} [partials] The arguments to be partially applied.
     * @returns {Function} Returns the new partially applied function.
     * @example
     *
     * function greet(greeting, name) {
     *   return greeting + ' ' + name;
     * }
     *
     * var sayHelloTo = _.partial(greet, 'hello');
     * sayHelloTo('fred');
     * // => 'hello fred'
     *
     * // Partially applied with placeholders.
     * var greetFred = _.partial(greet, _, 'fred');
     * greetFred('hi');
     * // => 'hi fred'
     */
    var partial = baseRest(function(func, partials) {
      var holders = replaceHolders(partials, getHolder(partial));
      return createWrap(func, WRAP_PARTIAL_FLAG, undefined, partials, holders);
    });

    /**
     * This method is like `_.partial` except that partially applied arguments
     * are appended to the arguments it receives.
     *
     * The `_.partialRight.placeholder` value, which defaults to `_` in monolithic
     * builds, may be used as a placeholder for partially applied arguments.
     *
     * **Note:** This method doesn't set the "length" property of partially
     * applied functions.
     *
     * @static
     * @memberOf _
     * @since 1.0.0
     * @category Function
     * @param {Function} func The function to partially apply arguments to.
     * @param {...*} [partials] The arguments to be partially applied.
     * @returns {Function} Returns the new partially applied function.
     * @example
     *
     * function greet(greeting, name) {
     *   return greeting + ' ' + name;
     * }
     *
     * var greetFred = _.partialRight(greet, 'fred');
     * greetFred('hi');
     * // => 'hi fred'
     *
     * // Partially applied with placeholders.
     * var sayHelloTo = _.partialRight(greet, 'hello', _);
     * sayHelloTo('fred');
     * // => 'hello fred'
     */
    var partialRight = baseRest(function(func, partials) {
      var holders = replaceHolders(partials, getHolder(partialRight));
      return createWrap(func, WRAP_PARTIAL_RIGHT_FLAG, undefined, partials, holders);
    });

    /**
     * Creates a function that invokes `func` with arguments arranged according
     * to the specified `indexes` where the argument value at the first index is
     * provided as the first argument, the argument value at the second index is
     * provided as the second argument, and so on.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Function
     * @param {Function} func The function to rearrange arguments for.
     * @param {...(number|number[])} indexes The arranged argument indexes.
     * @returns {Function} Returns the new function.
     * @example
     *
     * var rearged = _.rearg(function(a, b, c) {
     *   return [a, b, c];
     * }, [2, 0, 1]);
     *
     * rearged('b', 'c', 'a')
     * // => ['a', 'b', 'c']
     */
    var rearg = flatRest(function(func, indexes) {
      return createWrap(func, WRAP_REARG_FLAG, undefined, undefined, undefined, indexes);
    });

    /**
     * Creates a function that invokes `func` with the `this` binding of the
     * created function and arguments from `start` and beyond provided as
     * an array.
     *
     * **Note:** This method is based on the
     * [rest parameter](https://mdn.io/rest_parameters).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Function
     * @param {Function} func The function to apply a rest parameter to.
     * @param {number} [start=func.length-1] The start position of the rest parameter.
     * @returns {Function} Returns the new function.
     * @example
     *
     * var say = _.rest(function(what, names) {
     *   return what + ' ' + _.initial(names).join(', ') +
     *     (_.size(names) > 1 ? ', & ' : '') + _.last(names);
     * });
     *
     * say('hello', 'fred', 'barney', 'pebbles');
     * // => 'hello fred, barney, & pebbles'
     */
    function rest(func, start) {
      if (typeof func != 'function') {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      start = start === undefined ? start : toInteger(start);
      return baseRest(func, start);
    }

    /**
     * Creates a function that invokes `func` with the `this` binding of the
     * create function and an array of arguments much like
     * [`Function#apply`](http://www.ecma-international.org/ecma-262/7.0/#sec-function.prototype.apply).
     *
     * **Note:** This method is based on the
     * [spread operator](https://mdn.io/spread_operator).
     *
     * @static
     * @memberOf _
     * @since 3.2.0
     * @category Function
     * @param {Function} func The function to spread arguments over.
     * @param {number} [start=0] The start position of the spread.
     * @returns {Function} Returns the new function.
     * @example
     *
     * var say = _.spread(function(who, what) {
     *   return who + ' says ' + what;
     * });
     *
     * say(['fred', 'hello']);
     * // => 'fred says hello'
     *
     * var numbers = Promise.all([
     *   Promise.resolve(40),
     *   Promise.resolve(36)
     * ]);
     *
     * numbers.then(_.spread(function(x, y) {
     *   return x + y;
     * }));
     * // => a Promise of 76
     */
    function spread(func, start) {
      if (typeof func != 'function') {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      start = start == null ? 0 : nativeMax(toInteger(start), 0);
      return baseRest(function(args) {
        var array = args[start],
            otherArgs = castSlice(args, 0, start);

        if (array) {
          arrayPush(otherArgs, array);
        }
        return apply(func, this, otherArgs);
      });
    }

    /**
     * Creates a throttled function that only invokes `func` at most once per
     * every `wait` milliseconds. The throttled function comes with a `cancel`
     * method to cancel delayed `func` invocations and a `flush` method to
     * immediately invoke them. Provide `options` to indicate whether `func`
     * should be invoked on the leading and/or trailing edge of the `wait`
     * timeout. The `func` is invoked with the last arguments provided to the
     * throttled function. Subsequent calls to the throttled function return the
     * result of the last `func` invocation.
     *
     * **Note:** If `leading` and `trailing` options are `true`, `func` is
     * invoked on the trailing edge of the timeout only if the throttled function
     * is invoked more than once during the `wait` timeout.
     *
     * If `wait` is `0` and `leading` is `false`, `func` invocation is deferred
     * until to the next tick, similar to `setTimeout` with a timeout of `0`.
     *
     * See [David Corbacho's article](https://css-tricks.com/debouncing-throttling-explained-examples/)
     * for details over the differences between `_.throttle` and `_.debounce`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Function
     * @param {Function} func The function to throttle.
     * @param {number} [wait=0] The number of milliseconds to throttle invocations to.
     * @param {Object} [options={}] The options object.
     * @param {boolean} [options.leading=true]
     *  Specify invoking on the leading edge of the timeout.
     * @param {boolean} [options.trailing=true]
     *  Specify invoking on the trailing edge of the timeout.
     * @returns {Function} Returns the new throttled function.
     * @example
     *
     * // Avoid excessively updating the position while scrolling.
     * jQuery(window).on('scroll', _.throttle(updatePosition, 100));
     *
     * // Invoke `renewToken` when the click event is fired, but not more than once every 5 minutes.
     * var throttled = _.throttle(renewToken, 300000, { 'trailing': false });
     * jQuery(element).on('click', throttled);
     *
     * // Cancel the trailing throttled invocation.
     * jQuery(window).on('popstate', throttled.cancel);
     */
    function throttle(func, wait, options) {
      var leading = true,
          trailing = true;

      if (typeof func != 'function') {
        throw new TypeError(FUNC_ERROR_TEXT);
      }
      if (isObject(options)) {
        leading = 'leading' in options ? !!options.leading : leading;
        trailing = 'trailing' in options ? !!options.trailing : trailing;
      }
      return debounce(func, wait, {
        'leading': leading,
        'maxWait': wait,
        'trailing': trailing
      });
    }

    /**
     * Creates a function that accepts up to one argument, ignoring any
     * additional arguments.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Function
     * @param {Function} func The function to cap arguments for.
     * @returns {Function} Returns the new capped function.
     * @example
     *
     * _.map(['6', '8', '10'], _.unary(parseInt));
     * // => [6, 8, 10]
     */
    function unary(func) {
      return ary(func, 1);
    }

    /**
     * Creates a function that provides `value` to `wrapper` as its first
     * argument. Any additional arguments provided to the function are appended
     * to those provided to the `wrapper`. The wrapper is invoked with the `this`
     * binding of the created function.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Function
     * @param {*} value The value to wrap.
     * @param {Function} [wrapper=identity] The wrapper function.
     * @returns {Function} Returns the new function.
     * @example
     *
     * var p = _.wrap(_.escape, function(func, text) {
     *   return '<p>' + func(text) + '</p>';
     * });
     *
     * p('fred, barney, & pebbles');
     * // => '<p>fred, barney, &amp; pebbles</p>'
     */
    function wrap(value, wrapper) {
      return partial(castFunction(wrapper), value);
    }

    /*------------------------------------------------------------------------*/

    /**
     * Casts `value` as an array if it's not one.
     *
     * @static
     * @memberOf _
     * @since 4.4.0
     * @category Lang
     * @param {*} value The value to inspect.
     * @returns {Array} Returns the cast array.
     * @example
     *
     * _.castArray(1);
     * // => [1]
     *
     * _.castArray({ 'a': 1 });
     * // => [{ 'a': 1 }]
     *
     * _.castArray('abc');
     * // => ['abc']
     *
     * _.castArray(null);
     * // => [null]
     *
     * _.castArray(undefined);
     * // => [undefined]
     *
     * _.castArray();
     * // => []
     *
     * var array = [1, 2, 3];
     * console.log(_.castArray(array) === array);
     * // => true
     */
    function castArray() {
      if (!arguments.length) {
        return [];
      }
      var value = arguments[0];
      return isArray(value) ? value : [value];
    }

    /**
     * Creates a shallow clone of `value`.
     *
     * **Note:** This method is loosely based on the
     * [structured clone algorithm](https://mdn.io/Structured_clone_algorithm)
     * and supports cloning arrays, array buffers, booleans, date objects, maps,
     * numbers, `Object` objects, regexes, sets, strings, symbols, and typed
     * arrays. The own enumerable properties of `arguments` objects are cloned
     * as plain objects. An empty object is returned for uncloneable values such
     * as error objects, functions, DOM nodes, and WeakMaps.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to clone.
     * @returns {*} Returns the cloned value.
     * @see _.cloneDeep
     * @example
     *
     * var objects = [{ 'a': 1 }, { 'b': 2 }];
     *
     * var shallow = _.clone(objects);
     * console.log(shallow[0] === objects[0]);
     * // => true
     */
    function clone(value) {
      return baseClone(value, CLONE_SYMBOLS_FLAG);
    }

    /**
     * This method is like `_.clone` except that it accepts `customizer` which
     * is invoked to produce the cloned value. If `customizer` returns `undefined`,
     * cloning is handled by the method instead. The `customizer` is invoked with
     * up to four arguments; (value [, index|key, object, stack]).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to clone.
     * @param {Function} [customizer] The function to customize cloning.
     * @returns {*} Returns the cloned value.
     * @see _.cloneDeepWith
     * @example
     *
     * function customizer(value) {
     *   if (_.isElement(value)) {
     *     return value.cloneNode(false);
     *   }
     * }
     *
     * var el = _.cloneWith(document.body, customizer);
     *
     * console.log(el === document.body);
     * // => false
     * console.log(el.nodeName);
     * // => 'BODY'
     * console.log(el.childNodes.length);
     * // => 0
     */
    function cloneWith(value, customizer) {
      customizer = typeof customizer == 'function' ? customizer : undefined;
      return baseClone(value, CLONE_SYMBOLS_FLAG, customizer);
    }

    /**
     * This method is like `_.clone` except that it recursively clones `value`.
     *
     * @static
     * @memberOf _
     * @since 1.0.0
     * @category Lang
     * @param {*} value The value to recursively clone.
     * @returns {*} Returns the deep cloned value.
     * @see _.clone
     * @example
     *
     * var objects = [{ 'a': 1 }, { 'b': 2 }];
     *
     * var deep = _.cloneDeep(objects);
     * console.log(deep[0] === objects[0]);
     * // => false
     */
    function cloneDeep(value) {
      return baseClone(value, CLONE_DEEP_FLAG | CLONE_SYMBOLS_FLAG);
    }

    /**
     * This method is like `_.cloneWith` except that it recursively clones `value`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to recursively clone.
     * @param {Function} [customizer] The function to customize cloning.
     * @returns {*} Returns the deep cloned value.
     * @see _.cloneWith
     * @example
     *
     * function customizer(value) {
     *   if (_.isElement(value)) {
     *     return value.cloneNode(true);
     *   }
     * }
     *
     * var el = _.cloneDeepWith(document.body, customizer);
     *
     * console.log(el === document.body);
     * // => false
     * console.log(el.nodeName);
     * // => 'BODY'
     * console.log(el.childNodes.length);
     * // => 20
     */
    function cloneDeepWith(value, customizer) {
      customizer = typeof customizer == 'function' ? customizer : undefined;
      return baseClone(value, CLONE_DEEP_FLAG | CLONE_SYMBOLS_FLAG, customizer);
    }

    /**
     * Checks if `object` conforms to `source` by invoking the predicate
     * properties of `source` with the corresponding property values of `object`.
     *
     * **Note:** This method is equivalent to `_.conforms` when `source` is
     * partially applied.
     *
     * @static
     * @memberOf _
     * @since 4.14.0
     * @category Lang
     * @param {Object} object The object to inspect.
     * @param {Object} source The object of property predicates to conform to.
     * @returns {boolean} Returns `true` if `object` conforms, else `false`.
     * @example
     *
     * var object = { 'a': 1, 'b': 2 };
     *
     * _.conformsTo(object, { 'b': function(n) { return n > 1; } });
     * // => true
     *
     * _.conformsTo(object, { 'b': function(n) { return n > 2; } });
     * // => false
     */
    function conformsTo(object, source) {
      return source == null || baseConformsTo(object, source, keys(source));
    }

    /**
     * Performs a
     * [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
     * comparison between two values to determine if they are equivalent.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @returns {boolean} Returns `true` if the values are equivalent, else `false`.
     * @example
     *
     * var object = { 'a': 1 };
     * var other = { 'a': 1 };
     *
     * _.eq(object, object);
     * // => true
     *
     * _.eq(object, other);
     * // => false
     *
     * _.eq('a', 'a');
     * // => true
     *
     * _.eq('a', Object('a'));
     * // => false
     *
     * _.eq(NaN, NaN);
     * // => true
     */
    function eq(value, other) {
      return value === other || (value !== value && other !== other);
    }

    /**
     * Checks if `value` is greater than `other`.
     *
     * @static
     * @memberOf _
     * @since 3.9.0
     * @category Lang
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @returns {boolean} Returns `true` if `value` is greater than `other`,
     *  else `false`.
     * @see _.lt
     * @example
     *
     * _.gt(3, 1);
     * // => true
     *
     * _.gt(3, 3);
     * // => false
     *
     * _.gt(1, 3);
     * // => false
     */
    var gt = createRelationalOperation(baseGt);

    /**
     * Checks if `value` is greater than or equal to `other`.
     *
     * @static
     * @memberOf _
     * @since 3.9.0
     * @category Lang
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @returns {boolean} Returns `true` if `value` is greater than or equal to
     *  `other`, else `false`.
     * @see _.lte
     * @example
     *
     * _.gte(3, 1);
     * // => true
     *
     * _.gte(3, 3);
     * // => true
     *
     * _.gte(1, 3);
     * // => false
     */
    var gte = createRelationalOperation(function(value, other) {
      return value >= other;
    });

    /**
     * Checks if `value` is likely an `arguments` object.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is an `arguments` object,
     *  else `false`.
     * @example
     *
     * _.isArguments(function() { return arguments; }());
     * // => true
     *
     * _.isArguments([1, 2, 3]);
     * // => false
     */
    var isArguments = baseIsArguments(function() { return arguments; }()) ? baseIsArguments : function(value) {
      return isObjectLike(value) && hasOwnProperty.call(value, 'callee') &&
        !propertyIsEnumerable.call(value, 'callee');
    };

    /**
     * Checks if `value` is classified as an `Array` object.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is an array, else `false`.
     * @example
     *
     * _.isArray([1, 2, 3]);
     * // => true
     *
     * _.isArray(document.body.children);
     * // => false
     *
     * _.isArray('abc');
     * // => false
     *
     * _.isArray(_.noop);
     * // => false
     */
    var isArray = Array.isArray;

    /**
     * Checks if `value` is classified as an `ArrayBuffer` object.
     *
     * @static
     * @memberOf _
     * @since 4.3.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is an array buffer, else `false`.
     * @example
     *
     * _.isArrayBuffer(new ArrayBuffer(2));
     * // => true
     *
     * _.isArrayBuffer(new Array(2));
     * // => false
     */
    var isArrayBuffer = nodeIsArrayBuffer ? baseUnary(nodeIsArrayBuffer) : baseIsArrayBuffer;

    /**
     * Checks if `value` is array-like. A value is considered array-like if it's
     * not a function and has a `value.length` that's an integer greater than or
     * equal to `0` and less than or equal to `Number.MAX_SAFE_INTEGER`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is array-like, else `false`.
     * @example
     *
     * _.isArrayLike([1, 2, 3]);
     * // => true
     *
     * _.isArrayLike(document.body.children);
     * // => true
     *
     * _.isArrayLike('abc');
     * // => true
     *
     * _.isArrayLike(_.noop);
     * // => false
     */
    function isArrayLike(value) {
      return value != null && isLength(value.length) && !isFunction(value);
    }

    /**
     * This method is like `_.isArrayLike` except that it also checks if `value`
     * is an object.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is an array-like object,
     *  else `false`.
     * @example
     *
     * _.isArrayLikeObject([1, 2, 3]);
     * // => true
     *
     * _.isArrayLikeObject(document.body.children);
     * // => true
     *
     * _.isArrayLikeObject('abc');
     * // => false
     *
     * _.isArrayLikeObject(_.noop);
     * // => false
     */
    function isArrayLikeObject(value) {
      return isObjectLike(value) && isArrayLike(value);
    }

    /**
     * Checks if `value` is classified as a boolean primitive or object.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a boolean, else `false`.
     * @example
     *
     * _.isBoolean(false);
     * // => true
     *
     * _.isBoolean(null);
     * // => false
     */
    function isBoolean(value) {
      return value === true || value === false ||
        (isObjectLike(value) && baseGetTag(value) == boolTag);
    }

    /**
     * Checks if `value` is a buffer.
     *
     * @static
     * @memberOf _
     * @since 4.3.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a buffer, else `false`.
     * @example
     *
     * _.isBuffer(new Buffer(2));
     * // => true
     *
     * _.isBuffer(new Uint8Array(2));
     * // => false
     */
    var isBuffer = nativeIsBuffer || stubFalse;

    /**
     * Checks if `value` is classified as a `Date` object.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a date object, else `false`.
     * @example
     *
     * _.isDate(new Date);
     * // => true
     *
     * _.isDate('Mon April 23 2012');
     * // => false
     */
    var isDate = nodeIsDate ? baseUnary(nodeIsDate) : baseIsDate;

    /**
     * Checks if `value` is likely a DOM element.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a DOM element, else `false`.
     * @example
     *
     * _.isElement(document.body);
     * // => true
     *
     * _.isElement('<body>');
     * // => false
     */
    function isElement(value) {
      return isObjectLike(value) && value.nodeType === 1 && !isPlainObject(value);
    }

    /**
     * Checks if `value` is an empty object, collection, map, or set.
     *
     * Objects are considered empty if they have no own enumerable string keyed
     * properties.
     *
     * Array-like values such as `arguments` objects, arrays, buffers, strings, or
     * jQuery-like collections are considered empty if they have a `length` of `0`.
     * Similarly, maps and sets are considered empty if they have a `size` of `0`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is empty, else `false`.
     * @example
     *
     * _.isEmpty(null);
     * // => true
     *
     * _.isEmpty(true);
     * // => true
     *
     * _.isEmpty(1);
     * // => true
     *
     * _.isEmpty([1, 2, 3]);
     * // => false
     *
     * _.isEmpty({ 'a': 1 });
     * // => false
     */
    function isEmpty(value) {
      if (value == null) {
        return true;
      }
      if (isArrayLike(value) &&
          (isArray(value) || typeof value == 'string' || typeof value.splice == 'function' ||
            isBuffer(value) || isTypedArray(value) || isArguments(value))) {
        return !value.length;
      }
      var tag = getTag(value);
      if (tag == mapTag || tag == setTag) {
        return !value.size;
      }
      if (isPrototype(value)) {
        return !baseKeys(value).length;
      }
      for (var key in value) {
        if (hasOwnProperty.call(value, key)) {
          return false;
        }
      }
      return true;
    }

    /**
     * Performs a deep comparison between two values to determine if they are
     * equivalent.
     *
     * **Note:** This method supports comparing arrays, array buffers, booleans,
     * date objects, error objects, maps, numbers, `Object` objects, regexes,
     * sets, strings, symbols, and typed arrays. `Object` objects are compared
     * by their own, not inherited, enumerable properties. Functions and DOM
     * nodes are compared by strict equality, i.e. `===`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @returns {boolean} Returns `true` if the values are equivalent, else `false`.
     * @example
     *
     * var object = { 'a': 1 };
     * var other = { 'a': 1 };
     *
     * _.isEqual(object, other);
     * // => true
     *
     * object === other;
     * // => false
     */
    function isEqual(value, other) {
      return baseIsEqual(value, other);
    }

    /**
     * This method is like `_.isEqual` except that it accepts `customizer` which
     * is invoked to compare values. If `customizer` returns `undefined`, comparisons
     * are handled by the method instead. The `customizer` is invoked with up to
     * six arguments: (objValue, othValue [, index|key, object, other, stack]).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @param {Function} [customizer] The function to customize comparisons.
     * @returns {boolean} Returns `true` if the values are equivalent, else `false`.
     * @example
     *
     * function isGreeting(value) {
     *   return /^h(?:i|ello)$/.test(value);
     * }
     *
     * function customizer(objValue, othValue) {
     *   if (isGreeting(objValue) && isGreeting(othValue)) {
     *     return true;
     *   }
     * }
     *
     * var array = ['hello', 'goodbye'];
     * var other = ['hi', 'goodbye'];
     *
     * _.isEqualWith(array, other, customizer);
     * // => true
     */
    function isEqualWith(value, other, customizer) {
      customizer = typeof customizer == 'function' ? customizer : undefined;
      var result = customizer ? customizer(value, other) : undefined;
      return result === undefined ? baseIsEqual(value, other, undefined, customizer) : !!result;
    }

    /**
     * Checks if `value` is an `Error`, `EvalError`, `RangeError`, `ReferenceError`,
     * `SyntaxError`, `TypeError`, or `URIError` object.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is an error object, else `false`.
     * @example
     *
     * _.isError(new Error);
     * // => true
     *
     * _.isError(Error);
     * // => false
     */
    function isError(value) {
      if (!isObjectLike(value)) {
        return false;
      }
      var tag = baseGetTag(value);
      return tag == errorTag || tag == domExcTag ||
        (typeof value.message == 'string' && typeof value.name == 'string' && !isPlainObject(value));
    }

    /**
     * Checks if `value` is a finite primitive number.
     *
     * **Note:** This method is based on
     * [`Number.isFinite`](https://mdn.io/Number/isFinite).
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a finite number, else `false`.
     * @example
     *
     * _.isFinite(3);
     * // => true
     *
     * _.isFinite(Number.MIN_VALUE);
     * // => true
     *
     * _.isFinite(Infinity);
     * // => false
     *
     * _.isFinite('3');
     * // => false
     */
    function isFinite(value) {
      return typeof value == 'number' && nativeIsFinite(value);
    }

    /**
     * Checks if `value` is classified as a `Function` object.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a function, else `false`.
     * @example
     *
     * _.isFunction(_);
     * // => true
     *
     * _.isFunction(/abc/);
     * // => false
     */
    function isFunction(value) {
      if (!isObject(value)) {
        return false;
      }
      // The use of `Object#toString` avoids issues with the `typeof` operator
      // in Safari 9 which returns 'object' for typed arrays and other constructors.
      var tag = baseGetTag(value);
      return tag == funcTag || tag == genTag || tag == asyncTag || tag == proxyTag;
    }

    /**
     * Checks if `value` is an integer.
     *
     * **Note:** This method is based on
     * [`Number.isInteger`](https://mdn.io/Number/isInteger).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is an integer, else `false`.
     * @example
     *
     * _.isInteger(3);
     * // => true
     *
     * _.isInteger(Number.MIN_VALUE);
     * // => false
     *
     * _.isInteger(Infinity);
     * // => false
     *
     * _.isInteger('3');
     * // => false
     */
    function isInteger(value) {
      return typeof value == 'number' && value == toInteger(value);
    }

    /**
     * Checks if `value` is a valid array-like length.
     *
     * **Note:** This method is loosely based on
     * [`ToLength`](http://ecma-international.org/ecma-262/7.0/#sec-tolength).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a valid length, else `false`.
     * @example
     *
     * _.isLength(3);
     * // => true
     *
     * _.isLength(Number.MIN_VALUE);
     * // => false
     *
     * _.isLength(Infinity);
     * // => false
     *
     * _.isLength('3');
     * // => false
     */
    function isLength(value) {
      return typeof value == 'number' &&
        value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
    }

    /**
     * Checks if `value` is the
     * [language type](http://www.ecma-international.org/ecma-262/7.0/#sec-ecmascript-language-types)
     * of `Object`. (e.g. arrays, functions, objects, regexes, `new Number(0)`, and `new String('')`)
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is an object, else `false`.
     * @example
     *
     * _.isObject({});
     * // => true
     *
     * _.isObject([1, 2, 3]);
     * // => true
     *
     * _.isObject(_.noop);
     * // => true
     *
     * _.isObject(null);
     * // => false
     */
    function isObject(value) {
      var type = typeof value;
      return value != null && (type == 'object' || type == 'function');
    }

    /**
     * Checks if `value` is object-like. A value is object-like if it's not `null`
     * and has a `typeof` result of "object".
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is object-like, else `false`.
     * @example
     *
     * _.isObjectLike({});
     * // => true
     *
     * _.isObjectLike([1, 2, 3]);
     * // => true
     *
     * _.isObjectLike(_.noop);
     * // => false
     *
     * _.isObjectLike(null);
     * // => false
     */
    function isObjectLike(value) {
      return value != null && typeof value == 'object';
    }

    /**
     * Checks if `value` is classified as a `Map` object.
     *
     * @static
     * @memberOf _
     * @since 4.3.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a map, else `false`.
     * @example
     *
     * _.isMap(new Map);
     * // => true
     *
     * _.isMap(new WeakMap);
     * // => false
     */
    var isMap = nodeIsMap ? baseUnary(nodeIsMap) : baseIsMap;

    /**
     * Performs a partial deep comparison between `object` and `source` to
     * determine if `object` contains equivalent property values.
     *
     * **Note:** This method is equivalent to `_.matches` when `source` is
     * partially applied.
     *
     * Partial comparisons will match empty array and empty object `source`
     * values against any array or object value, respectively. See `_.isEqual`
     * for a list of supported value comparisons.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Lang
     * @param {Object} object The object to inspect.
     * @param {Object} source The object of property values to match.
     * @returns {boolean} Returns `true` if `object` is a match, else `false`.
     * @example
     *
     * var object = { 'a': 1, 'b': 2 };
     *
     * _.isMatch(object, { 'b': 2 });
     * // => true
     *
     * _.isMatch(object, { 'b': 1 });
     * // => false
     */
    function isMatch(object, source) {
      return object === source || baseIsMatch(object, source, getMatchData(source));
    }

    /**
     * This method is like `_.isMatch` except that it accepts `customizer` which
     * is invoked to compare values. If `customizer` returns `undefined`, comparisons
     * are handled by the method instead. The `customizer` is invoked with five
     * arguments: (objValue, srcValue, index|key, object, source).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {Object} object The object to inspect.
     * @param {Object} source The object of property values to match.
     * @param {Function} [customizer] The function to customize comparisons.
     * @returns {boolean} Returns `true` if `object` is a match, else `false`.
     * @example
     *
     * function isGreeting(value) {
     *   return /^h(?:i|ello)$/.test(value);
     * }
     *
     * function customizer(objValue, srcValue) {
     *   if (isGreeting(objValue) && isGreeting(srcValue)) {
     *     return true;
     *   }
     * }
     *
     * var object = { 'greeting': 'hello' };
     * var source = { 'greeting': 'hi' };
     *
     * _.isMatchWith(object, source, customizer);
     * // => true
     */
    function isMatchWith(object, source, customizer) {
      customizer = typeof customizer == 'function' ? customizer : undefined;
      return baseIsMatch(object, source, getMatchData(source), customizer);
    }

    /**
     * Checks if `value` is `NaN`.
     *
     * **Note:** This method is based on
     * [`Number.isNaN`](https://mdn.io/Number/isNaN) and is not the same as
     * global [`isNaN`](https://mdn.io/isNaN) which returns `true` for
     * `undefined` and other non-number values.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is `NaN`, else `false`.
     * @example
     *
     * _.isNaN(NaN);
     * // => true
     *
     * _.isNaN(new Number(NaN));
     * // => true
     *
     * isNaN(undefined);
     * // => true
     *
     * _.isNaN(undefined);
     * // => false
     */
    function isNaN(value) {
      // An `NaN` primitive is the only value that is not equal to itself.
      // Perform the `toStringTag` check first to avoid errors with some
      // ActiveX objects in IE.
      return isNumber(value) && value != +value;
    }

    /**
     * Checks if `value` is a pristine native function.
     *
     * **Note:** This method can't reliably detect native functions in the presence
     * of the core-js package because core-js circumvents this kind of detection.
     * Despite multiple requests, the core-js maintainer has made it clear: any
     * attempt to fix the detection will be obstructed. As a result, we're left
     * with little choice but to throw an error. Unfortunately, this also affects
     * packages, like [babel-polyfill](https://www.npmjs.com/package/babel-polyfill),
     * which rely on core-js.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a native function,
     *  else `false`.
     * @example
     *
     * _.isNative(Array.prototype.push);
     * // => true
     *
     * _.isNative(_);
     * // => false
     */
    function isNative(value) {
      if (isMaskable(value)) {
        throw new Error(CORE_ERROR_TEXT);
      }
      return baseIsNative(value);
    }

    /**
     * Checks if `value` is `null`.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is `null`, else `false`.
     * @example
     *
     * _.isNull(null);
     * // => true
     *
     * _.isNull(void 0);
     * // => false
     */
    function isNull(value) {
      return value === null;
    }

    /**
     * Checks if `value` is `null` or `undefined`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is nullish, else `false`.
     * @example
     *
     * _.isNil(null);
     * // => true
     *
     * _.isNil(void 0);
     * // => true
     *
     * _.isNil(NaN);
     * // => false
     */
    function isNil(value) {
      return value == null;
    }

    /**
     * Checks if `value` is classified as a `Number` primitive or object.
     *
     * **Note:** To exclude `Infinity`, `-Infinity`, and `NaN`, which are
     * classified as numbers, use the `_.isFinite` method.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a number, else `false`.
     * @example
     *
     * _.isNumber(3);
     * // => true
     *
     * _.isNumber(Number.MIN_VALUE);
     * // => true
     *
     * _.isNumber(Infinity);
     * // => true
     *
     * _.isNumber('3');
     * // => false
     */
    function isNumber(value) {
      return typeof value == 'number' ||
        (isObjectLike(value) && baseGetTag(value) == numberTag);
    }

    /**
     * Checks if `value` is a plain object, that is, an object created by the
     * `Object` constructor or one with a `[[Prototype]]` of `null`.
     *
     * @static
     * @memberOf _
     * @since 0.8.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a plain object, else `false`.
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     * }
     *
     * _.isPlainObject(new Foo);
     * // => false
     *
     * _.isPlainObject([1, 2, 3]);
     * // => false
     *
     * _.isPlainObject({ 'x': 0, 'y': 0 });
     * // => true
     *
     * _.isPlainObject(Object.create(null));
     * // => true
     */
    function isPlainObject(value) {
      if (!isObjectLike(value) || baseGetTag(value) != objectTag) {
        return false;
      }
      var proto = getPrototype(value);
      if (proto === null) {
        return true;
      }
      var Ctor = hasOwnProperty.call(proto, 'constructor') && proto.constructor;
      return typeof Ctor == 'function' && Ctor instanceof Ctor &&
        funcToString.call(Ctor) == objectCtorString;
    }

    /**
     * Checks if `value` is classified as a `RegExp` object.
     *
     * @static
     * @memberOf _
     * @since 0.1.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a regexp, else `false`.
     * @example
     *
     * _.isRegExp(/abc/);
     * // => true
     *
     * _.isRegExp('/abc/');
     * // => false
     */
    var isRegExp = nodeIsRegExp ? baseUnary(nodeIsRegExp) : baseIsRegExp;

    /**
     * Checks if `value` is a safe integer. An integer is safe if it's an IEEE-754
     * double precision number which isn't the result of a rounded unsafe integer.
     *
     * **Note:** This method is based on
     * [`Number.isSafeInteger`](https://mdn.io/Number/isSafeInteger).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a safe integer, else `false`.
     * @example
     *
     * _.isSafeInteger(3);
     * // => true
     *
     * _.isSafeInteger(Number.MIN_VALUE);
     * // => false
     *
     * _.isSafeInteger(Infinity);
     * // => false
     *
     * _.isSafeInteger('3');
     * // => false
     */
    function isSafeInteger(value) {
      return isInteger(value) && value >= -MAX_SAFE_INTEGER && value <= MAX_SAFE_INTEGER;
    }

    /**
     * Checks if `value` is classified as a `Set` object.
     *
     * @static
     * @memberOf _
     * @since 4.3.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a set, else `false`.
     * @example
     *
     * _.isSet(new Set);
     * // => true
     *
     * _.isSet(new WeakSet);
     * // => false
     */
    var isSet = nodeIsSet ? baseUnary(nodeIsSet) : baseIsSet;

    /**
     * Checks if `value` is classified as a `String` primitive or object.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a string, else `false`.
     * @example
     *
     * _.isString('abc');
     * // => true
     *
     * _.isString(1);
     * // => false
     */
    function isString(value) {
      return typeof value == 'string' ||
        (!isArray(value) && isObjectLike(value) && baseGetTag(value) == stringTag);
    }

    /**
     * Checks if `value` is classified as a `Symbol` primitive or object.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a symbol, else `false`.
     * @example
     *
     * _.isSymbol(Symbol.iterator);
     * // => true
     *
     * _.isSymbol('abc');
     * // => false
     */
    function isSymbol(value) {
      return typeof value == 'symbol' ||
        (isObjectLike(value) && baseGetTag(value) == symbolTag);
    }

    /**
     * Checks if `value` is classified as a typed array.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a typed array, else `false`.
     * @example
     *
     * _.isTypedArray(new Uint8Array);
     * // => true
     *
     * _.isTypedArray([]);
     * // => false
     */
    var isTypedArray = nodeIsTypedArray ? baseUnary(nodeIsTypedArray) : baseIsTypedArray;

    /**
     * Checks if `value` is `undefined`.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is `undefined`, else `false`.
     * @example
     *
     * _.isUndefined(void 0);
     * // => true
     *
     * _.isUndefined(null);
     * // => false
     */
    function isUndefined(value) {
      return value === undefined;
    }

    /**
     * Checks if `value` is classified as a `WeakMap` object.
     *
     * @static
     * @memberOf _
     * @since 4.3.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a weak map, else `false`.
     * @example
     *
     * _.isWeakMap(new WeakMap);
     * // => true
     *
     * _.isWeakMap(new Map);
     * // => false
     */
    function isWeakMap(value) {
      return isObjectLike(value) && getTag(value) == weakMapTag;
    }

    /**
     * Checks if `value` is classified as a `WeakSet` object.
     *
     * @static
     * @memberOf _
     * @since 4.3.0
     * @category Lang
     * @param {*} value The value to check.
     * @returns {boolean} Returns `true` if `value` is a weak set, else `false`.
     * @example
     *
     * _.isWeakSet(new WeakSet);
     * // => true
     *
     * _.isWeakSet(new Set);
     * // => false
     */
    function isWeakSet(value) {
      return isObjectLike(value) && baseGetTag(value) == weakSetTag;
    }

    /**
     * Checks if `value` is less than `other`.
     *
     * @static
     * @memberOf _
     * @since 3.9.0
     * @category Lang
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @returns {boolean} Returns `true` if `value` is less than `other`,
     *  else `false`.
     * @see _.gt
     * @example
     *
     * _.lt(1, 3);
     * // => true
     *
     * _.lt(3, 3);
     * // => false
     *
     * _.lt(3, 1);
     * // => false
     */
    var lt = createRelationalOperation(baseLt);

    /**
     * Checks if `value` is less than or equal to `other`.
     *
     * @static
     * @memberOf _
     * @since 3.9.0
     * @category Lang
     * @param {*} value The value to compare.
     * @param {*} other The other value to compare.
     * @returns {boolean} Returns `true` if `value` is less than or equal to
     *  `other`, else `false`.
     * @see _.gte
     * @example
     *
     * _.lte(1, 3);
     * // => true
     *
     * _.lte(3, 3);
     * // => true
     *
     * _.lte(3, 1);
     * // => false
     */
    var lte = createRelationalOperation(function(value, other) {
      return value <= other;
    });

    /**
     * Converts `value` to an array.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Lang
     * @param {*} value The value to convert.
     * @returns {Array} Returns the converted array.
     * @example
     *
     * _.toArray({ 'a': 1, 'b': 2 });
     * // => [1, 2]
     *
     * _.toArray('abc');
     * // => ['a', 'b', 'c']
     *
     * _.toArray(1);
     * // => []
     *
     * _.toArray(null);
     * // => []
     */
    function toArray(value) {
      if (!value) {
        return [];
      }
      if (isArrayLike(value)) {
        return isString(value) ? stringToArray(value) : copyArray(value);
      }
      if (symIterator && value[symIterator]) {
        return iteratorToArray(value[symIterator]());
      }
      var tag = getTag(value),
          func = tag == mapTag ? mapToArray : (tag == setTag ? setToArray : values);

      return func(value);
    }

    /**
     * Converts `value` to a finite number.
     *
     * @static
     * @memberOf _
     * @since 4.12.0
     * @category Lang
     * @param {*} value The value to convert.
     * @returns {number} Returns the converted number.
     * @example
     *
     * _.toFinite(3.2);
     * // => 3.2
     *
     * _.toFinite(Number.MIN_VALUE);
     * // => 5e-324
     *
     * _.toFinite(Infinity);
     * // => 1.7976931348623157e+308
     *
     * _.toFinite('3.2');
     * // => 3.2
     */
    function toFinite(value) {
      if (!value) {
        return value === 0 ? value : 0;
      }
      value = toNumber(value);
      if (value === INFINITY || value === -INFINITY) {
        var sign = (value < 0 ? -1 : 1);
        return sign * MAX_INTEGER;
      }
      return value === value ? value : 0;
    }

    /**
     * Converts `value` to an integer.
     *
     * **Note:** This method is loosely based on
     * [`ToInteger`](http://www.ecma-international.org/ecma-262/7.0/#sec-tointeger).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to convert.
     * @returns {number} Returns the converted integer.
     * @example
     *
     * _.toInteger(3.2);
     * // => 3
     *
     * _.toInteger(Number.MIN_VALUE);
     * // => 0
     *
     * _.toInteger(Infinity);
     * // => 1.7976931348623157e+308
     *
     * _.toInteger('3.2');
     * // => 3
     */
    function toInteger(value) {
      var result = toFinite(value),
          remainder = result % 1;

      return result === result ? (remainder ? result - remainder : result) : 0;
    }

    /**
     * Converts `value` to an integer suitable for use as the length of an
     * array-like object.
     *
     * **Note:** This method is based on
     * [`ToLength`](http://ecma-international.org/ecma-262/7.0/#sec-tolength).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to convert.
     * @returns {number} Returns the converted integer.
     * @example
     *
     * _.toLength(3.2);
     * // => 3
     *
     * _.toLength(Number.MIN_VALUE);
     * // => 0
     *
     * _.toLength(Infinity);
     * // => 4294967295
     *
     * _.toLength('3.2');
     * // => 3
     */
    function toLength(value) {
      return value ? baseClamp(toInteger(value), 0, MAX_ARRAY_LENGTH) : 0;
    }

    /**
     * Converts `value` to a number.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to process.
     * @returns {number} Returns the number.
     * @example
     *
     * _.toNumber(3.2);
     * // => 3.2
     *
     * _.toNumber(Number.MIN_VALUE);
     * // => 5e-324
     *
     * _.toNumber(Infinity);
     * // => Infinity
     *
     * _.toNumber('3.2');
     * // => 3.2
     */
    function toNumber(value) {
      if (typeof value == 'number') {
        return value;
      }
      if (isSymbol(value)) {
        return NAN;
      }
      if (isObject(value)) {
        var other = typeof value.valueOf == 'function' ? value.valueOf() : value;
        value = isObject(other) ? (other + '') : other;
      }
      if (typeof value != 'string') {
        return value === 0 ? value : +value;
      }
      value = value.replace(reTrim, '');
      var isBinary = reIsBinary.test(value);
      return (isBinary || reIsOctal.test(value))
        ? freeParseInt(value.slice(2), isBinary ? 2 : 8)
        : (reIsBadHex.test(value) ? NAN : +value);
    }

    /**
     * Converts `value` to a plain object flattening inherited enumerable string
     * keyed properties of `value` to own properties of the plain object.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Lang
     * @param {*} value The value to convert.
     * @returns {Object} Returns the converted plain object.
     * @example
     *
     * function Foo() {
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.assign({ 'a': 1 }, new Foo);
     * // => { 'a': 1, 'b': 2 }
     *
     * _.assign({ 'a': 1 }, _.toPlainObject(new Foo));
     * // => { 'a': 1, 'b': 2, 'c': 3 }
     */
    function toPlainObject(value) {
      return copyObject(value, keysIn(value));
    }

    /**
     * Converts `value` to a safe integer. A safe integer can be compared and
     * represented correctly.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to convert.
     * @returns {number} Returns the converted integer.
     * @example
     *
     * _.toSafeInteger(3.2);
     * // => 3
     *
     * _.toSafeInteger(Number.MIN_VALUE);
     * // => 0
     *
     * _.toSafeInteger(Infinity);
     * // => 9007199254740991
     *
     * _.toSafeInteger('3.2');
     * // => 3
     */
    function toSafeInteger(value) {
      return value
        ? baseClamp(toInteger(value), -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)
        : (value === 0 ? value : 0);
    }

    /**
     * Converts `value` to a string. An empty string is returned for `null`
     * and `undefined` values. The sign of `-0` is preserved.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Lang
     * @param {*} value The value to convert.
     * @returns {string} Returns the converted string.
     * @example
     *
     * _.toString(null);
     * // => ''
     *
     * _.toString(-0);
     * // => '-0'
     *
     * _.toString([1, 2, 3]);
     * // => '1,2,3'
     */
    function toString(value) {
      return value == null ? '' : baseToString(value);
    }

    /*------------------------------------------------------------------------*/

    /**
     * Assigns own enumerable string keyed properties of source objects to the
     * destination object. Source objects are applied from left to right.
     * Subsequent sources overwrite property assignments of previous sources.
     *
     * **Note:** This method mutates `object` and is loosely based on
     * [`Object.assign`](https://mdn.io/Object/assign).
     *
     * @static
     * @memberOf _
     * @since 0.10.0
     * @category Object
     * @param {Object} object The destination object.
     * @param {...Object} [sources] The source objects.
     * @returns {Object} Returns `object`.
     * @see _.assignIn
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     * }
     *
     * function Bar() {
     *   this.c = 3;
     * }
     *
     * Foo.prototype.b = 2;
     * Bar.prototype.d = 4;
     *
     * _.assign({ 'a': 0 }, new Foo, new Bar);
     * // => { 'a': 1, 'c': 3 }
     */
    var assign = createAssigner(function(object, source) {
      if (isPrototype(source) || isArrayLike(source)) {
        copyObject(source, keys(source), object);
        return;
      }
      for (var key in source) {
        if (hasOwnProperty.call(source, key)) {
          assignValue(object, key, source[key]);
        }
      }
    });

    /**
     * This method is like `_.assign` except that it iterates over own and
     * inherited source properties.
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @alias extend
     * @category Object
     * @param {Object} object The destination object.
     * @param {...Object} [sources] The source objects.
     * @returns {Object} Returns `object`.
     * @see _.assign
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     * }
     *
     * function Bar() {
     *   this.c = 3;
     * }
     *
     * Foo.prototype.b = 2;
     * Bar.prototype.d = 4;
     *
     * _.assignIn({ 'a': 0 }, new Foo, new Bar);
     * // => { 'a': 1, 'b': 2, 'c': 3, 'd': 4 }
     */
    var assignIn = createAssigner(function(object, source) {
      copyObject(source, keysIn(source), object);
    });

    /**
     * This method is like `_.assignIn` except that it accepts `customizer`
     * which is invoked to produce the assigned values. If `customizer` returns
     * `undefined`, assignment is handled by the method instead. The `customizer`
     * is invoked with five arguments: (objValue, srcValue, key, object, source).
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @alias extendWith
     * @category Object
     * @param {Object} object The destination object.
     * @param {...Object} sources The source objects.
     * @param {Function} [customizer] The function to customize assigned values.
     * @returns {Object} Returns `object`.
     * @see _.assignWith
     * @example
     *
     * function customizer(objValue, srcValue) {
     *   return _.isUndefined(objValue) ? srcValue : objValue;
     * }
     *
     * var defaults = _.partialRight(_.assignInWith, customizer);
     *
     * defaults({ 'a': 1 }, { 'b': 2 }, { 'a': 3 });
     * // => { 'a': 1, 'b': 2 }
     */
    var assignInWith = createAssigner(function(object, source, srcIndex, customizer) {
      copyObject(source, keysIn(source), object, customizer);
    });

    /**
     * This method is like `_.assign` except that it accepts `customizer`
     * which is invoked to produce the assigned values. If `customizer` returns
     * `undefined`, assignment is handled by the method instead. The `customizer`
     * is invoked with five arguments: (objValue, srcValue, key, object, source).
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Object
     * @param {Object} object The destination object.
     * @param {...Object} sources The source objects.
     * @param {Function} [customizer] The function to customize assigned values.
     * @returns {Object} Returns `object`.
     * @see _.assignInWith
     * @example
     *
     * function customizer(objValue, srcValue) {
     *   return _.isUndefined(objValue) ? srcValue : objValue;
     * }
     *
     * var defaults = _.partialRight(_.assignWith, customizer);
     *
     * defaults({ 'a': 1 }, { 'b': 2 }, { 'a': 3 });
     * // => { 'a': 1, 'b': 2 }
     */
    var assignWith = createAssigner(function(object, source, srcIndex, customizer) {
      copyObject(source, keys(source), object, customizer);
    });

    /**
     * Creates an array of values corresponding to `paths` of `object`.
     *
     * @static
     * @memberOf _
     * @since 1.0.0
     * @category Object
     * @param {Object} object The object to iterate over.
     * @param {...(string|string[])} [paths] The property paths to pick.
     * @returns {Array} Returns the picked values.
     * @example
     *
     * var object = { 'a': [{ 'b': { 'c': 3 } }, 4] };
     *
     * _.at(object, ['a[0].b.c', 'a[1]']);
     * // => [3, 4]
     */
    var at = flatRest(baseAt);

    /**
     * Creates an object that inherits from the `prototype` object. If a
     * `properties` object is given, its own enumerable string keyed properties
     * are assigned to the created object.
     *
     * @static
     * @memberOf _
     * @since 2.3.0
     * @category Object
     * @param {Object} prototype The object to inherit from.
     * @param {Object} [properties] The properties to assign to the object.
     * @returns {Object} Returns the new object.
     * @example
     *
     * function Shape() {
     *   this.x = 0;
     *   this.y = 0;
     * }
     *
     * function Circle() {
     *   Shape.call(this);
     * }
     *
     * Circle.prototype = _.create(Shape.prototype, {
     *   'constructor': Circle
     * });
     *
     * var circle = new Circle;
     * circle instanceof Circle;
     * // => true
     *
     * circle instanceof Shape;
     * // => true
     */
    function create(prototype, properties) {
      var result = baseCreate(prototype);
      return properties == null ? result : baseAssign(result, properties);
    }

    /**
     * Assigns own and inherited enumerable string keyed properties of source
     * objects to the destination object for all destination properties that
     * resolve to `undefined`. Source objects are applied from left to right.
     * Once a property is set, additional values of the same property are ignored.
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Object
     * @param {Object} object The destination object.
     * @param {...Object} [sources] The source objects.
     * @returns {Object} Returns `object`.
     * @see _.defaultsDeep
     * @example
     *
     * _.defaults({ 'a': 1 }, { 'b': 2 }, { 'a': 3 });
     * // => { 'a': 1, 'b': 2 }
     */
    var defaults = baseRest(function(args) {
      args.push(undefined, customDefaultsAssignIn);
      return apply(assignInWith, undefined, args);
    });

    /**
     * This method is like `_.defaults` except that it recursively assigns
     * default properties.
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 3.10.0
     * @category Object
     * @param {Object} object The destination object.
     * @param {...Object} [sources] The source objects.
     * @returns {Object} Returns `object`.
     * @see _.defaults
     * @example
     *
     * _.defaultsDeep({ 'a': { 'b': 2 } }, { 'a': { 'b': 1, 'c': 3 } });
     * // => { 'a': { 'b': 2, 'c': 3 } }
     */
    var defaultsDeep = baseRest(function(args) {
      args.push(undefined, customDefaultsMerge);
      return apply(mergeWith, undefined, args);
    });

    /**
     * This method is like `_.find` except that it returns the key of the first
     * element `predicate` returns truthy for instead of the element itself.
     *
     * @static
     * @memberOf _
     * @since 1.1.0
     * @category Object
     * @param {Object} object The object to inspect.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @returns {string|undefined} Returns the key of the matched element,
     *  else `undefined`.
     * @example
     *
     * var users = {
     *   'barney':  { 'age': 36, 'active': true },
     *   'fred':    { 'age': 40, 'active': false },
     *   'pebbles': { 'age': 1,  'active': true }
     * };
     *
     * _.findKey(users, function(o) { return o.age < 40; });
     * // => 'barney' (iteration order is not guaranteed)
     *
     * // The `_.matches` iteratee shorthand.
     * _.findKey(users, { 'age': 1, 'active': true });
     * // => 'pebbles'
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.findKey(users, ['active', false]);
     * // => 'fred'
     *
     * // The `_.property` iteratee shorthand.
     * _.findKey(users, 'active');
     * // => 'barney'
     */
    function findKey(object, predicate) {
      return baseFindKey(object, getIteratee(predicate, 3), baseForOwn);
    }

    /**
     * This method is like `_.findKey` except that it iterates over elements of
     * a collection in the opposite order.
     *
     * @static
     * @memberOf _
     * @since 2.0.0
     * @category Object
     * @param {Object} object The object to inspect.
     * @param {Function} [predicate=_.identity] The function invoked per iteration.
     * @returns {string|undefined} Returns the key of the matched element,
     *  else `undefined`.
     * @example
     *
     * var users = {
     *   'barney':  { 'age': 36, 'active': true },
     *   'fred':    { 'age': 40, 'active': false },
     *   'pebbles': { 'age': 1,  'active': true }
     * };
     *
     * _.findLastKey(users, function(o) { return o.age < 40; });
     * // => returns 'pebbles' assuming `_.findKey` returns 'barney'
     *
     * // The `_.matches` iteratee shorthand.
     * _.findLastKey(users, { 'age': 36, 'active': true });
     * // => 'barney'
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.findLastKey(users, ['active', false]);
     * // => 'fred'
     *
     * // The `_.property` iteratee shorthand.
     * _.findLastKey(users, 'active');
     * // => 'pebbles'
     */
    function findLastKey(object, predicate) {
      return baseFindKey(object, getIteratee(predicate, 3), baseForOwnRight);
    }

    /**
     * Iterates over own and inherited enumerable string keyed properties of an
     * object and invokes `iteratee` for each property. The iteratee is invoked
     * with three arguments: (value, key, object). Iteratee functions may exit
     * iteration early by explicitly returning `false`.
     *
     * @static
     * @memberOf _
     * @since 0.3.0
     * @category Object
     * @param {Object} object The object to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Object} Returns `object`.
     * @see _.forInRight
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.forIn(new Foo, function(value, key) {
     *   console.log(key);
     * });
     * // => Logs 'a', 'b', then 'c' (iteration order is not guaranteed).
     */
    function forIn(object, iteratee) {
      return object == null
        ? object
        : baseFor(object, getIteratee(iteratee, 3), keysIn);
    }

    /**
     * This method is like `_.forIn` except that it iterates over properties of
     * `object` in the opposite order.
     *
     * @static
     * @memberOf _
     * @since 2.0.0
     * @category Object
     * @param {Object} object The object to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Object} Returns `object`.
     * @see _.forIn
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.forInRight(new Foo, function(value, key) {
     *   console.log(key);
     * });
     * // => Logs 'c', 'b', then 'a' assuming `_.forIn` logs 'a', 'b', then 'c'.
     */
    function forInRight(object, iteratee) {
      return object == null
        ? object
        : baseForRight(object, getIteratee(iteratee, 3), keysIn);
    }

    /**
     * Iterates over own enumerable string keyed properties of an object and
     * invokes `iteratee` for each property. The iteratee is invoked with three
     * arguments: (value, key, object). Iteratee functions may exit iteration
     * early by explicitly returning `false`.
     *
     * @static
     * @memberOf _
     * @since 0.3.0
     * @category Object
     * @param {Object} object The object to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Object} Returns `object`.
     * @see _.forOwnRight
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.forOwn(new Foo, function(value, key) {
     *   console.log(key);
     * });
     * // => Logs 'a' then 'b' (iteration order is not guaranteed).
     */
    function forOwn(object, iteratee) {
      return object && baseForOwn(object, getIteratee(iteratee, 3));
    }

    /**
     * This method is like `_.forOwn` except that it iterates over properties of
     * `object` in the opposite order.
     *
     * @static
     * @memberOf _
     * @since 2.0.0
     * @category Object
     * @param {Object} object The object to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Object} Returns `object`.
     * @see _.forOwn
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.forOwnRight(new Foo, function(value, key) {
     *   console.log(key);
     * });
     * // => Logs 'b' then 'a' assuming `_.forOwn` logs 'a' then 'b'.
     */
    function forOwnRight(object, iteratee) {
      return object && baseForOwnRight(object, getIteratee(iteratee, 3));
    }

    /**
     * Creates an array of function property names from own enumerable properties
     * of `object`.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Object
     * @param {Object} object The object to inspect.
     * @returns {Array} Returns the function names.
     * @see _.functionsIn
     * @example
     *
     * function Foo() {
     *   this.a = _.constant('a');
     *   this.b = _.constant('b');
     * }
     *
     * Foo.prototype.c = _.constant('c');
     *
     * _.functions(new Foo);
     * // => ['a', 'b']
     */
    function functions(object) {
      return object == null ? [] : baseFunctions(object, keys(object));
    }

    /**
     * Creates an array of function property names from own and inherited
     * enumerable properties of `object`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Object
     * @param {Object} object The object to inspect.
     * @returns {Array} Returns the function names.
     * @see _.functions
     * @example
     *
     * function Foo() {
     *   this.a = _.constant('a');
     *   this.b = _.constant('b');
     * }
     *
     * Foo.prototype.c = _.constant('c');
     *
     * _.functionsIn(new Foo);
     * // => ['a', 'b', 'c']
     */
    function functionsIn(object) {
      return object == null ? [] : baseFunctions(object, keysIn(object));
    }

    /**
     * Gets the value at `path` of `object`. If the resolved value is
     * `undefined`, the `defaultValue` is returned in its place.
     *
     * @static
     * @memberOf _
     * @since 3.7.0
     * @category Object
     * @param {Object} object The object to query.
     * @param {Array|string} path The path of the property to get.
     * @param {*} [defaultValue] The value returned for `undefined` resolved values.
     * @returns {*} Returns the resolved value.
     * @example
     *
     * var object = { 'a': [{ 'b': { 'c': 3 } }] };
     *
     * _.get(object, 'a[0].b.c');
     * // => 3
     *
     * _.get(object, ['a', '0', 'b', 'c']);
     * // => 3
     *
     * _.get(object, 'a.b.c', 'default');
     * // => 'default'
     */
    function get(object, path, defaultValue) {
      var result = object == null ? undefined : baseGet(object, path);
      return result === undefined ? defaultValue : result;
    }

    /**
     * Checks if `path` is a direct property of `object`.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Object
     * @param {Object} object The object to query.
     * @param {Array|string} path The path to check.
     * @returns {boolean} Returns `true` if `path` exists, else `false`.
     * @example
     *
     * var object = { 'a': { 'b': 2 } };
     * var other = _.create({ 'a': _.create({ 'b': 2 }) });
     *
     * _.has(object, 'a');
     * // => true
     *
     * _.has(object, 'a.b');
     * // => true
     *
     * _.has(object, ['a', 'b']);
     * // => true
     *
     * _.has(other, 'a');
     * // => false
     */
    function has(object, path) {
      return object != null && hasPath(object, path, baseHas);
    }

    /**
     * Checks if `path` is a direct or inherited property of `object`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Object
     * @param {Object} object The object to query.
     * @param {Array|string} path The path to check.
     * @returns {boolean} Returns `true` if `path` exists, else `false`.
     * @example
     *
     * var object = _.create({ 'a': _.create({ 'b': 2 }) });
     *
     * _.hasIn(object, 'a');
     * // => true
     *
     * _.hasIn(object, 'a.b');
     * // => true
     *
     * _.hasIn(object, ['a', 'b']);
     * // => true
     *
     * _.hasIn(object, 'b');
     * // => false
     */
    function hasIn(object, path) {
      return object != null && hasPath(object, path, baseHasIn);
    }

    /**
     * Creates an object composed of the inverted keys and values of `object`.
     * If `object` contains duplicate values, subsequent values overwrite
     * property assignments of previous values.
     *
     * @static
     * @memberOf _
     * @since 0.7.0
     * @category Object
     * @param {Object} object The object to invert.
     * @returns {Object} Returns the new inverted object.
     * @example
     *
     * var object = { 'a': 1, 'b': 2, 'c': 1 };
     *
     * _.invert(object);
     * // => { '1': 'c', '2': 'b' }
     */
    var invert = createInverter(function(result, value, key) {
      result[value] = key;
    }, constant(identity));

    /**
     * This method is like `_.invert` except that the inverted object is generated
     * from the results of running each element of `object` thru `iteratee`. The
     * corresponding inverted value of each inverted key is an array of keys
     * responsible for generating the inverted value. The iteratee is invoked
     * with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 4.1.0
     * @category Object
     * @param {Object} object The object to invert.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {Object} Returns the new inverted object.
     * @example
     *
     * var object = { 'a': 1, 'b': 2, 'c': 1 };
     *
     * _.invertBy(object);
     * // => { '1': ['a', 'c'], '2': ['b'] }
     *
     * _.invertBy(object, function(value) {
     *   return 'group' + value;
     * });
     * // => { 'group1': ['a', 'c'], 'group2': ['b'] }
     */
    var invertBy = createInverter(function(result, value, key) {
      if (hasOwnProperty.call(result, value)) {
        result[value].push(key);
      } else {
        result[value] = [key];
      }
    }, getIteratee);

    /**
     * Invokes the method at `path` of `object`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Object
     * @param {Object} object The object to query.
     * @param {Array|string} path The path of the method to invoke.
     * @param {...*} [args] The arguments to invoke the method with.
     * @returns {*} Returns the result of the invoked method.
     * @example
     *
     * var object = { 'a': [{ 'b': { 'c': [1, 2, 3, 4] } }] };
     *
     * _.invoke(object, 'a[0].b.c.slice', 1, 3);
     * // => [2, 3]
     */
    var invoke = baseRest(baseInvoke);

    /**
     * Creates an array of the own enumerable property names of `object`.
     *
     * **Note:** Non-object values are coerced to objects. See the
     * [ES spec](http://ecma-international.org/ecma-262/7.0/#sec-object.keys)
     * for more details.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Object
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of property names.
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.keys(new Foo);
     * // => ['a', 'b'] (iteration order is not guaranteed)
     *
     * _.keys('hi');
     * // => ['0', '1']
     */
    function keys(object) {
      return isArrayLike(object) ? arrayLikeKeys(object) : baseKeys(object);
    }

    /**
     * Creates an array of the own and inherited enumerable property names of `object`.
     *
     * **Note:** Non-object values are coerced to objects.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Object
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of property names.
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.keysIn(new Foo);
     * // => ['a', 'b', 'c'] (iteration order is not guaranteed)
     */
    function keysIn(object) {
      return isArrayLike(object) ? arrayLikeKeys(object, true) : baseKeysIn(object);
    }

    /**
     * The opposite of `_.mapValues`; this method creates an object with the
     * same values as `object` and keys generated by running each own enumerable
     * string keyed property of `object` thru `iteratee`. The iteratee is invoked
     * with three arguments: (value, key, object).
     *
     * @static
     * @memberOf _
     * @since 3.8.0
     * @category Object
     * @param {Object} object The object to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Object} Returns the new mapped object.
     * @see _.mapValues
     * @example
     *
     * _.mapKeys({ 'a': 1, 'b': 2 }, function(value, key) {
     *   return key + value;
     * });
     * // => { 'a1': 1, 'b2': 2 }
     */
    function mapKeys(object, iteratee) {
      var result = {};
      iteratee = getIteratee(iteratee, 3);

      baseForOwn(object, function(value, key, object) {
        baseAssignValue(result, iteratee(value, key, object), value);
      });
      return result;
    }

    /**
     * Creates an object with the same keys as `object` and values generated
     * by running each own enumerable string keyed property of `object` thru
     * `iteratee`. The iteratee is invoked with three arguments:
     * (value, key, object).
     *
     * @static
     * @memberOf _
     * @since 2.4.0
     * @category Object
     * @param {Object} object The object to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Object} Returns the new mapped object.
     * @see _.mapKeys
     * @example
     *
     * var users = {
     *   'fred':    { 'user': 'fred',    'age': 40 },
     *   'pebbles': { 'user': 'pebbles', 'age': 1 }
     * };
     *
     * _.mapValues(users, function(o) { return o.age; });
     * // => { 'fred': 40, 'pebbles': 1 } (iteration order is not guaranteed)
     *
     * // The `_.property` iteratee shorthand.
     * _.mapValues(users, 'age');
     * // => { 'fred': 40, 'pebbles': 1 } (iteration order is not guaranteed)
     */
    function mapValues(object, iteratee) {
      var result = {};
      iteratee = getIteratee(iteratee, 3);

      baseForOwn(object, function(value, key, object) {
        baseAssignValue(result, key, iteratee(value, key, object));
      });
      return result;
    }

    /**
     * This method is like `_.assign` except that it recursively merges own and
     * inherited enumerable string keyed properties of source objects into the
     * destination object. Source properties that resolve to `undefined` are
     * skipped if a destination value exists. Array and plain object properties
     * are merged recursively. Other objects and value types are overridden by
     * assignment. Source objects are applied from left to right. Subsequent
     * sources overwrite property assignments of previous sources.
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 0.5.0
     * @category Object
     * @param {Object} object The destination object.
     * @param {...Object} [sources] The source objects.
     * @returns {Object} Returns `object`.
     * @example
     *
     * var object = {
     *   'a': [{ 'b': 2 }, { 'd': 4 }]
     * };
     *
     * var other = {
     *   'a': [{ 'c': 3 }, { 'e': 5 }]
     * };
     *
     * _.merge(object, other);
     * // => { 'a': [{ 'b': 2, 'c': 3 }, { 'd': 4, 'e': 5 }] }
     */
    var merge = createAssigner(function(object, source, srcIndex) {
      baseMerge(object, source, srcIndex);
    });

    /**
     * This method is like `_.merge` except that it accepts `customizer` which
     * is invoked to produce the merged values of the destination and source
     * properties. If `customizer` returns `undefined`, merging is handled by the
     * method instead. The `customizer` is invoked with six arguments:
     * (objValue, srcValue, key, object, source, stack).
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Object
     * @param {Object} object The destination object.
     * @param {...Object} sources The source objects.
     * @param {Function} customizer The function to customize assigned values.
     * @returns {Object} Returns `object`.
     * @example
     *
     * function customizer(objValue, srcValue) {
     *   if (_.isArray(objValue)) {
     *     return objValue.concat(srcValue);
     *   }
     * }
     *
     * var object = { 'a': [1], 'b': [2] };
     * var other = { 'a': [3], 'b': [4] };
     *
     * _.mergeWith(object, other, customizer);
     * // => { 'a': [1, 3], 'b': [2, 4] }
     */
    var mergeWith = createAssigner(function(object, source, srcIndex, customizer) {
      baseMerge(object, source, srcIndex, customizer);
    });

    /**
     * The opposite of `_.pick`; this method creates an object composed of the
     * own and inherited enumerable property paths of `object` that are not omitted.
     *
     * **Note:** This method is considerably slower than `_.pick`.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Object
     * @param {Object} object The source object.
     * @param {...(string|string[])} [paths] The property paths to omit.
     * @returns {Object} Returns the new object.
     * @example
     *
     * var object = { 'a': 1, 'b': '2', 'c': 3 };
     *
     * _.omit(object, ['a', 'c']);
     * // => { 'b': '2' }
     */
    var omit = flatRest(function(object, paths) {
      var result = {};
      if (object == null) {
        return result;
      }
      var isDeep = false;
      paths = arrayMap(paths, function(path) {
        path = castPath(path, object);
        isDeep || (isDeep = path.length > 1);
        return path;
      });
      copyObject(object, getAllKeysIn(object), result);
      if (isDeep) {
        result = baseClone(result, CLONE_DEEP_FLAG | CLONE_FLAT_FLAG | CLONE_SYMBOLS_FLAG, customOmitClone);
      }
      var length = paths.length;
      while (length--) {
        baseUnset(result, paths[length]);
      }
      return result;
    });

    /**
     * The opposite of `_.pickBy`; this method creates an object composed of
     * the own and inherited enumerable string keyed properties of `object` that
     * `predicate` doesn't return truthy for. The predicate is invoked with two
     * arguments: (value, key).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Object
     * @param {Object} object The source object.
     * @param {Function} [predicate=_.identity] The function invoked per property.
     * @returns {Object} Returns the new object.
     * @example
     *
     * var object = { 'a': 1, 'b': '2', 'c': 3 };
     *
     * _.omitBy(object, _.isNumber);
     * // => { 'b': '2' }
     */
    function omitBy(object, predicate) {
      return pickBy(object, negate(getIteratee(predicate)));
    }

    /**
     * Creates an object composed of the picked `object` properties.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Object
     * @param {Object} object The source object.
     * @param {...(string|string[])} [paths] The property paths to pick.
     * @returns {Object} Returns the new object.
     * @example
     *
     * var object = { 'a': 1, 'b': '2', 'c': 3 };
     *
     * _.pick(object, ['a', 'c']);
     * // => { 'a': 1, 'c': 3 }
     */
    var pick = flatRest(function(object, paths) {
      return object == null ? {} : basePick(object, paths);
    });

    /**
     * Creates an object composed of the `object` properties `predicate` returns
     * truthy for. The predicate is invoked with two arguments: (value, key).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Object
     * @param {Object} object The source object.
     * @param {Function} [predicate=_.identity] The function invoked per property.
     * @returns {Object} Returns the new object.
     * @example
     *
     * var object = { 'a': 1, 'b': '2', 'c': 3 };
     *
     * _.pickBy(object, _.isNumber);
     * // => { 'a': 1, 'c': 3 }
     */
    function pickBy(object, predicate) {
      if (object == null) {
        return {};
      }
      var props = arrayMap(getAllKeysIn(object), function(prop) {
        return [prop];
      });
      predicate = getIteratee(predicate);
      return basePickBy(object, props, function(value, path) {
        return predicate(value, path[0]);
      });
    }

    /**
     * This method is like `_.get` except that if the resolved value is a
     * function it's invoked with the `this` binding of its parent object and
     * its result is returned.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Object
     * @param {Object} object The object to query.
     * @param {Array|string} path The path of the property to resolve.
     * @param {*} [defaultValue] The value returned for `undefined` resolved values.
     * @returns {*} Returns the resolved value.
     * @example
     *
     * var object = { 'a': [{ 'b': { 'c1': 3, 'c2': _.constant(4) } }] };
     *
     * _.result(object, 'a[0].b.c1');
     * // => 3
     *
     * _.result(object, 'a[0].b.c2');
     * // => 4
     *
     * _.result(object, 'a[0].b.c3', 'default');
     * // => 'default'
     *
     * _.result(object, 'a[0].b.c3', _.constant('default'));
     * // => 'default'
     */
    function result(object, path, defaultValue) {
      path = castPath(path, object);

      var index = -1,
          length = path.length;

      // Ensure the loop is entered when path is empty.
      if (!length) {
        length = 1;
        object = undefined;
      }
      while (++index < length) {
        var value = object == null ? undefined : object[toKey(path[index])];
        if (value === undefined) {
          index = length;
          value = defaultValue;
        }
        object = isFunction(value) ? value.call(object) : value;
      }
      return object;
    }

    /**
     * Sets the value at `path` of `object`. If a portion of `path` doesn't exist,
     * it's created. Arrays are created for missing index properties while objects
     * are created for all other missing properties. Use `_.setWith` to customize
     * `path` creation.
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 3.7.0
     * @category Object
     * @param {Object} object The object to modify.
     * @param {Array|string} path The path of the property to set.
     * @param {*} value The value to set.
     * @returns {Object} Returns `object`.
     * @example
     *
     * var object = { 'a': [{ 'b': { 'c': 3 } }] };
     *
     * _.set(object, 'a[0].b.c', 4);
     * console.log(object.a[0].b.c);
     * // => 4
     *
     * _.set(object, ['x', '0', 'y', 'z'], 5);
     * console.log(object.x[0].y.z);
     * // => 5
     */
    function set(object, path, value) {
      return object == null ? object : baseSet(object, path, value);
    }

    /**
     * This method is like `_.set` except that it accepts `customizer` which is
     * invoked to produce the objects of `path`.  If `customizer` returns `undefined`
     * path creation is handled by the method instead. The `customizer` is invoked
     * with three arguments: (nsValue, key, nsObject).
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Object
     * @param {Object} object The object to modify.
     * @param {Array|string} path The path of the property to set.
     * @param {*} value The value to set.
     * @param {Function} [customizer] The function to customize assigned values.
     * @returns {Object} Returns `object`.
     * @example
     *
     * var object = {};
     *
     * _.setWith(object, '[0][1]', 'a', Object);
     * // => { '0': { '1': 'a' } }
     */
    function setWith(object, path, value, customizer) {
      customizer = typeof customizer == 'function' ? customizer : undefined;
      return object == null ? object : baseSet(object, path, value, customizer);
    }

    /**
     * Creates an array of own enumerable string keyed-value pairs for `object`
     * which can be consumed by `_.fromPairs`. If `object` is a map or set, its
     * entries are returned.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @alias entries
     * @category Object
     * @param {Object} object The object to query.
     * @returns {Array} Returns the key-value pairs.
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.toPairs(new Foo);
     * // => [['a', 1], ['b', 2]] (iteration order is not guaranteed)
     */
    var toPairs = createToPairs(keys);

    /**
     * Creates an array of own and inherited enumerable string keyed-value pairs
     * for `object` which can be consumed by `_.fromPairs`. If `object` is a map
     * or set, its entries are returned.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @alias entriesIn
     * @category Object
     * @param {Object} object The object to query.
     * @returns {Array} Returns the key-value pairs.
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.toPairsIn(new Foo);
     * // => [['a', 1], ['b', 2], ['c', 3]] (iteration order is not guaranteed)
     */
    var toPairsIn = createToPairs(keysIn);

    /**
     * An alternative to `_.reduce`; this method transforms `object` to a new
     * `accumulator` object which is the result of running each of its own
     * enumerable string keyed properties thru `iteratee`, with each invocation
     * potentially mutating the `accumulator` object. If `accumulator` is not
     * provided, a new object with the same `[[Prototype]]` will be used. The
     * iteratee is invoked with four arguments: (accumulator, value, key, object).
     * Iteratee functions may exit iteration early by explicitly returning `false`.
     *
     * @static
     * @memberOf _
     * @since 1.3.0
     * @category Object
     * @param {Object} object The object to iterate over.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @param {*} [accumulator] The custom accumulator value.
     * @returns {*} Returns the accumulated value.
     * @example
     *
     * _.transform([2, 3, 4], function(result, n) {
     *   result.push(n *= n);
     *   return n % 2 == 0;
     * }, []);
     * // => [4, 9]
     *
     * _.transform({ 'a': 1, 'b': 2, 'c': 1 }, function(result, value, key) {
     *   (result[value] || (result[value] = [])).push(key);
     * }, {});
     * // => { '1': ['a', 'c'], '2': ['b'] }
     */
    function transform(object, iteratee, accumulator) {
      var isArr = isArray(object),
          isArrLike = isArr || isBuffer(object) || isTypedArray(object);

      iteratee = getIteratee(iteratee, 4);
      if (accumulator == null) {
        var Ctor = object && object.constructor;
        if (isArrLike) {
          accumulator = isArr ? new Ctor : [];
        }
        else if (isObject(object)) {
          accumulator = isFunction(Ctor) ? baseCreate(getPrototype(object)) : {};
        }
        else {
          accumulator = {};
        }
      }
      (isArrLike ? arrayEach : baseForOwn)(object, function(value, index, object) {
        return iteratee(accumulator, value, index, object);
      });
      return accumulator;
    }

    /**
     * Removes the property at `path` of `object`.
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Object
     * @param {Object} object The object to modify.
     * @param {Array|string} path The path of the property to unset.
     * @returns {boolean} Returns `true` if the property is deleted, else `false`.
     * @example
     *
     * var object = { 'a': [{ 'b': { 'c': 7 } }] };
     * _.unset(object, 'a[0].b.c');
     * // => true
     *
     * console.log(object);
     * // => { 'a': [{ 'b': {} }] };
     *
     * _.unset(object, ['a', '0', 'b', 'c']);
     * // => true
     *
     * console.log(object);
     * // => { 'a': [{ 'b': {} }] };
     */
    function unset(object, path) {
      return object == null ? true : baseUnset(object, path);
    }

    /**
     * This method is like `_.set` except that accepts `updater` to produce the
     * value to set. Use `_.updateWith` to customize `path` creation. The `updater`
     * is invoked with one argument: (value).
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 4.6.0
     * @category Object
     * @param {Object} object The object to modify.
     * @param {Array|string} path The path of the property to set.
     * @param {Function} updater The function to produce the updated value.
     * @returns {Object} Returns `object`.
     * @example
     *
     * var object = { 'a': [{ 'b': { 'c': 3 } }] };
     *
     * _.update(object, 'a[0].b.c', function(n) { return n * n; });
     * console.log(object.a[0].b.c);
     * // => 9
     *
     * _.update(object, 'x[0].y.z', function(n) { return n ? n + 1 : 0; });
     * console.log(object.x[0].y.z);
     * // => 0
     */
    function update(object, path, updater) {
      return object == null ? object : baseUpdate(object, path, castFunction(updater));
    }

    /**
     * This method is like `_.update` except that it accepts `customizer` which is
     * invoked to produce the objects of `path`.  If `customizer` returns `undefined`
     * path creation is handled by the method instead. The `customizer` is invoked
     * with three arguments: (nsValue, key, nsObject).
     *
     * **Note:** This method mutates `object`.
     *
     * @static
     * @memberOf _
     * @since 4.6.0
     * @category Object
     * @param {Object} object The object to modify.
     * @param {Array|string} path The path of the property to set.
     * @param {Function} updater The function to produce the updated value.
     * @param {Function} [customizer] The function to customize assigned values.
     * @returns {Object} Returns `object`.
     * @example
     *
     * var object = {};
     *
     * _.updateWith(object, '[0][1]', _.constant('a'), Object);
     * // => { '0': { '1': 'a' } }
     */
    function updateWith(object, path, updater, customizer) {
      customizer = typeof customizer == 'function' ? customizer : undefined;
      return object == null ? object : baseUpdate(object, path, castFunction(updater), customizer);
    }

    /**
     * Creates an array of the own enumerable string keyed property values of `object`.
     *
     * **Note:** Non-object values are coerced to objects.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Object
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of property values.
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.values(new Foo);
     * // => [1, 2] (iteration order is not guaranteed)
     *
     * _.values('hi');
     * // => ['h', 'i']
     */
    function values(object) {
      return object == null ? [] : baseValues(object, keys(object));
    }

    /**
     * Creates an array of the own and inherited enumerable string keyed property
     * values of `object`.
     *
     * **Note:** Non-object values are coerced to objects.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Object
     * @param {Object} object The object to query.
     * @returns {Array} Returns the array of property values.
     * @example
     *
     * function Foo() {
     *   this.a = 1;
     *   this.b = 2;
     * }
     *
     * Foo.prototype.c = 3;
     *
     * _.valuesIn(new Foo);
     * // => [1, 2, 3] (iteration order is not guaranteed)
     */
    function valuesIn(object) {
      return object == null ? [] : baseValues(object, keysIn(object));
    }

    /*------------------------------------------------------------------------*/

    /**
     * Clamps `number` within the inclusive `lower` and `upper` bounds.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Number
     * @param {number} number The number to clamp.
     * @param {number} [lower] The lower bound.
     * @param {number} upper The upper bound.
     * @returns {number} Returns the clamped number.
     * @example
     *
     * _.clamp(-10, -5, 5);
     * // => -5
     *
     * _.clamp(10, -5, 5);
     * // => 5
     */
    function clamp(number, lower, upper) {
      if (upper === undefined) {
        upper = lower;
        lower = undefined;
      }
      if (upper !== undefined) {
        upper = toNumber(upper);
        upper = upper === upper ? upper : 0;
      }
      if (lower !== undefined) {
        lower = toNumber(lower);
        lower = lower === lower ? lower : 0;
      }
      return baseClamp(toNumber(number), lower, upper);
    }

    /**
     * Checks if `n` is between `start` and up to, but not including, `end`. If
     * `end` is not specified, it's set to `start` with `start` then set to `0`.
     * If `start` is greater than `end` the params are swapped to support
     * negative ranges.
     *
     * @static
     * @memberOf _
     * @since 3.3.0
     * @category Number
     * @param {number} number The number to check.
     * @param {number} [start=0] The start of the range.
     * @param {number} end The end of the range.
     * @returns {boolean} Returns `true` if `number` is in the range, else `false`.
     * @see _.range, _.rangeRight
     * @example
     *
     * _.inRange(3, 2, 4);
     * // => true
     *
     * _.inRange(4, 8);
     * // => true
     *
     * _.inRange(4, 2);
     * // => false
     *
     * _.inRange(2, 2);
     * // => false
     *
     * _.inRange(1.2, 2);
     * // => true
     *
     * _.inRange(5.2, 4);
     * // => false
     *
     * _.inRange(-3, -2, -6);
     * // => true
     */
    function inRange(number, start, end) {
      start = toFinite(start);
      if (end === undefined) {
        end = start;
        start = 0;
      } else {
        end = toFinite(end);
      }
      number = toNumber(number);
      return baseInRange(number, start, end);
    }

    /**
     * Produces a random number between the inclusive `lower` and `upper` bounds.
     * If only one argument is provided a number between `0` and the given number
     * is returned. If `floating` is `true`, or either `lower` or `upper` are
     * floats, a floating-point number is returned instead of an integer.
     *
     * **Note:** JavaScript follows the IEEE-754 standard for resolving
     * floating-point values which can produce unexpected results.
     *
     * @static
     * @memberOf _
     * @since 0.7.0
     * @category Number
     * @param {number} [lower=0] The lower bound.
     * @param {number} [upper=1] The upper bound.
     * @param {boolean} [floating] Specify returning a floating-point number.
     * @returns {number} Returns the random number.
     * @example
     *
     * _.random(0, 5);
     * // => an integer between 0 and 5
     *
     * _.random(5);
     * // => also an integer between 0 and 5
     *
     * _.random(5, true);
     * // => a floating-point number between 0 and 5
     *
     * _.random(1.2, 5.2);
     * // => a floating-point number between 1.2 and 5.2
     */
    function random(lower, upper, floating) {
      if (floating && typeof floating != 'boolean' && isIterateeCall(lower, upper, floating)) {
        upper = floating = undefined;
      }
      if (floating === undefined) {
        if (typeof upper == 'boolean') {
          floating = upper;
          upper = undefined;
        }
        else if (typeof lower == 'boolean') {
          floating = lower;
          lower = undefined;
        }
      }
      if (lower === undefined && upper === undefined) {
        lower = 0;
        upper = 1;
      }
      else {
        lower = toFinite(lower);
        if (upper === undefined) {
          upper = lower;
          lower = 0;
        } else {
          upper = toFinite(upper);
        }
      }
      if (lower > upper) {
        var temp = lower;
        lower = upper;
        upper = temp;
      }
      if (floating || lower % 1 || upper % 1) {
        var rand = nativeRandom();
        return nativeMin(lower + (rand * (upper - lower + freeParseFloat('1e-' + ((rand + '').length - 1)))), upper);
      }
      return baseRandom(lower, upper);
    }

    /*------------------------------------------------------------------------*/

    /**
     * Converts `string` to [camel case](https://en.wikipedia.org/wiki/CamelCase).
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to convert.
     * @returns {string} Returns the camel cased string.
     * @example
     *
     * _.camelCase('Foo Bar');
     * // => 'fooBar'
     *
     * _.camelCase('--foo-bar--');
     * // => 'fooBar'
     *
     * _.camelCase('__FOO_BAR__');
     * // => 'fooBar'
     */
    var camelCase = createCompounder(function(result, word, index) {
      word = word.toLowerCase();
      return result + (index ? capitalize(word) : word);
    });

    /**
     * Converts the first character of `string` to upper case and the remaining
     * to lower case.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to capitalize.
     * @returns {string} Returns the capitalized string.
     * @example
     *
     * _.capitalize('FRED');
     * // => 'Fred'
     */
    function capitalize(string) {
      return upperFirst(toString(string).toLowerCase());
    }

    /**
     * Deburrs `string` by converting
     * [Latin-1 Supplement](https://en.wikipedia.org/wiki/Latin-1_Supplement_(Unicode_block)#Character_table)
     * and [Latin Extended-A](https://en.wikipedia.org/wiki/Latin_Extended-A)
     * letters to basic Latin letters and removing
     * [combining diacritical marks](https://en.wikipedia.org/wiki/Combining_Diacritical_Marks).
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to deburr.
     * @returns {string} Returns the deburred string.
     * @example
     *
     * _.deburr('déjà vu');
     * // => 'deja vu'
     */
    function deburr(string) {
      string = toString(string);
      return string && string.replace(reLatin, deburrLetter).replace(reComboMark, '');
    }

    /**
     * Checks if `string` ends with the given target string.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to inspect.
     * @param {string} [target] The string to search for.
     * @param {number} [position=string.length] The position to search up to.
     * @returns {boolean} Returns `true` if `string` ends with `target`,
     *  else `false`.
     * @example
     *
     * _.endsWith('abc', 'c');
     * // => true
     *
     * _.endsWith('abc', 'b');
     * // => false
     *
     * _.endsWith('abc', 'b', 2);
     * // => true
     */
    function endsWith(string, target, position) {
      string = toString(string);
      target = baseToString(target);

      var length = string.length;
      position = position === undefined
        ? length
        : baseClamp(toInteger(position), 0, length);

      var end = position;
      position -= target.length;
      return position >= 0 && string.slice(position, end) == target;
    }

    /**
     * Converts the characters "&", "<", ">", '"', and "'" in `string` to their
     * corresponding HTML entities.
     *
     * **Note:** No other characters are escaped. To escape additional
     * characters use a third-party library like [_he_](https://mths.be/he).
     *
     * Though the ">" character is escaped for symmetry, characters like
     * ">" and "/" don't need escaping in HTML and have no special meaning
     * unless they're part of a tag or unquoted attribute value. See
     * [Mathias Bynens's article](https://mathiasbynens.be/notes/ambiguous-ampersands)
     * (under "semi-related fun fact") for more details.
     *
     * When working with HTML you should always
     * [quote attribute values](http://wonko.com/post/html-escaping) to reduce
     * XSS vectors.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category String
     * @param {string} [string=''] The string to escape.
     * @returns {string} Returns the escaped string.
     * @example
     *
     * _.escape('fred, barney, & pebbles');
     * // => 'fred, barney, &amp; pebbles'
     */
    function escape(string) {
      string = toString(string);
      return (string && reHasUnescapedHtml.test(string))
        ? string.replace(reUnescapedHtml, escapeHtmlChar)
        : string;
    }

    /**
     * Escapes the `RegExp` special characters "^", "$", "\", ".", "*", "+",
     * "?", "(", ")", "[", "]", "{", "}", and "|" in `string`.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to escape.
     * @returns {string} Returns the escaped string.
     * @example
     *
     * _.escapeRegExp('[lodash](https://lodash.com/)');
     * // => '\[lodash\]\(https://lodash\.com/\)'
     */
    function escapeRegExp(string) {
      string = toString(string);
      return (string && reHasRegExpChar.test(string))
        ? string.replace(reRegExpChar, '\\$&')
        : string;
    }

    /**
     * Converts `string` to
     * [kebab case](https://en.wikipedia.org/wiki/Letter_case#Special_case_styles).
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to convert.
     * @returns {string} Returns the kebab cased string.
     * @example
     *
     * _.kebabCase('Foo Bar');
     * // => 'foo-bar'
     *
     * _.kebabCase('fooBar');
     * // => 'foo-bar'
     *
     * _.kebabCase('__FOO_BAR__');
     * // => 'foo-bar'
     */
    var kebabCase = createCompounder(function(result, word, index) {
      return result + (index ? '-' : '') + word.toLowerCase();
    });

    /**
     * Converts `string`, as space separated words, to lower case.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to convert.
     * @returns {string} Returns the lower cased string.
     * @example
     *
     * _.lowerCase('--Foo-Bar--');
     * // => 'foo bar'
     *
     * _.lowerCase('fooBar');
     * // => 'foo bar'
     *
     * _.lowerCase('__FOO_BAR__');
     * // => 'foo bar'
     */
    var lowerCase = createCompounder(function(result, word, index) {
      return result + (index ? ' ' : '') + word.toLowerCase();
    });

    /**
     * Converts the first character of `string` to lower case.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to convert.
     * @returns {string} Returns the converted string.
     * @example
     *
     * _.lowerFirst('Fred');
     * // => 'fred'
     *
     * _.lowerFirst('FRED');
     * // => 'fRED'
     */
    var lowerFirst = createCaseFirst('toLowerCase');

    /**
     * Pads `string` on the left and right sides if it's shorter than `length`.
     * Padding characters are truncated if they can't be evenly divided by `length`.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to pad.
     * @param {number} [length=0] The padding length.
     * @param {string} [chars=' '] The string used as padding.
     * @returns {string} Returns the padded string.
     * @example
     *
     * _.pad('abc', 8);
     * // => '  abc   '
     *
     * _.pad('abc', 8, '_-');
     * // => '_-abc_-_'
     *
     * _.pad('abc', 3);
     * // => 'abc'
     */
    function pad(string, length, chars) {
      string = toString(string);
      length = toInteger(length);

      var strLength = length ? stringSize(string) : 0;
      if (!length || strLength >= length) {
        return string;
      }
      var mid = (length - strLength) / 2;
      return (
        createPadding(nativeFloor(mid), chars) +
        string +
        createPadding(nativeCeil(mid), chars)
      );
    }

    /**
     * Pads `string` on the right side if it's shorter than `length`. Padding
     * characters are truncated if they exceed `length`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to pad.
     * @param {number} [length=0] The padding length.
     * @param {string} [chars=' '] The string used as padding.
     * @returns {string} Returns the padded string.
     * @example
     *
     * _.padEnd('abc', 6);
     * // => 'abc   '
     *
     * _.padEnd('abc', 6, '_-');
     * // => 'abc_-_'
     *
     * _.padEnd('abc', 3);
     * // => 'abc'
     */
    function padEnd(string, length, chars) {
      string = toString(string);
      length = toInteger(length);

      var strLength = length ? stringSize(string) : 0;
      return (length && strLength < length)
        ? (string + createPadding(length - strLength, chars))
        : string;
    }

    /**
     * Pads `string` on the left side if it's shorter than `length`. Padding
     * characters are truncated if they exceed `length`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to pad.
     * @param {number} [length=0] The padding length.
     * @param {string} [chars=' '] The string used as padding.
     * @returns {string} Returns the padded string.
     * @example
     *
     * _.padStart('abc', 6);
     * // => '   abc'
     *
     * _.padStart('abc', 6, '_-');
     * // => '_-_abc'
     *
     * _.padStart('abc', 3);
     * // => 'abc'
     */
    function padStart(string, length, chars) {
      string = toString(string);
      length = toInteger(length);

      var strLength = length ? stringSize(string) : 0;
      return (length && strLength < length)
        ? (createPadding(length - strLength, chars) + string)
        : string;
    }

    /**
     * Converts `string` to an integer of the specified radix. If `radix` is
     * `undefined` or `0`, a `radix` of `10` is used unless `value` is a
     * hexadecimal, in which case a `radix` of `16` is used.
     *
     * **Note:** This method aligns with the
     * [ES5 implementation](https://es5.github.io/#x15.1.2.2) of `parseInt`.
     *
     * @static
     * @memberOf _
     * @since 1.1.0
     * @category String
     * @param {string} string The string to convert.
     * @param {number} [radix=10] The radix to interpret `value` by.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {number} Returns the converted integer.
     * @example
     *
     * _.parseInt('08');
     * // => 8
     *
     * _.map(['6', '08', '10'], _.parseInt);
     * // => [6, 8, 10]
     */
    function parseInt(string, radix, guard) {
      if (guard || radix == null) {
        radix = 0;
      } else if (radix) {
        radix = +radix;
      }
      return nativeParseInt(toString(string).replace(reTrimStart, ''), radix || 0);
    }

    /**
     * Repeats the given string `n` times.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to repeat.
     * @param {number} [n=1] The number of times to repeat the string.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {string} Returns the repeated string.
     * @example
     *
     * _.repeat('*', 3);
     * // => '***'
     *
     * _.repeat('abc', 2);
     * // => 'abcabc'
     *
     * _.repeat('abc', 0);
     * // => ''
     */
    function repeat(string, n, guard) {
      if ((guard ? isIterateeCall(string, n, guard) : n === undefined)) {
        n = 1;
      } else {
        n = toInteger(n);
      }
      return baseRepeat(toString(string), n);
    }

    /**
     * Replaces matches for `pattern` in `string` with `replacement`.
     *
     * **Note:** This method is based on
     * [`String#replace`](https://mdn.io/String/replace).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to modify.
     * @param {RegExp|string} pattern The pattern to replace.
     * @param {Function|string} replacement The match replacement.
     * @returns {string} Returns the modified string.
     * @example
     *
     * _.replace('Hi Fred', 'Fred', 'Barney');
     * // => 'Hi Barney'
     */
    function replace() {
      var args = arguments,
          string = toString(args[0]);

      return args.length < 3 ? string : string.replace(args[1], args[2]);
    }

    /**
     * Converts `string` to
     * [snake case](https://en.wikipedia.org/wiki/Snake_case).
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to convert.
     * @returns {string} Returns the snake cased string.
     * @example
     *
     * _.snakeCase('Foo Bar');
     * // => 'foo_bar'
     *
     * _.snakeCase('fooBar');
     * // => 'foo_bar'
     *
     * _.snakeCase('--FOO-BAR--');
     * // => 'foo_bar'
     */
    var snakeCase = createCompounder(function(result, word, index) {
      return result + (index ? '_' : '') + word.toLowerCase();
    });

    /**
     * Splits `string` by `separator`.
     *
     * **Note:** This method is based on
     * [`String#split`](https://mdn.io/String/split).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to split.
     * @param {RegExp|string} separator The separator pattern to split by.
     * @param {number} [limit] The length to truncate results to.
     * @returns {Array} Returns the string segments.
     * @example
     *
     * _.split('a-b-c', '-', 2);
     * // => ['a', 'b']
     */
    function split(string, separator, limit) {
      if (limit && typeof limit != 'number' && isIterateeCall(string, separator, limit)) {
        separator = limit = undefined;
      }
      limit = limit === undefined ? MAX_ARRAY_LENGTH : limit >>> 0;
      if (!limit) {
        return [];
      }
      string = toString(string);
      if (string && (
            typeof separator == 'string' ||
            (separator != null && !isRegExp(separator))
          )) {
        separator = baseToString(separator);
        if (!separator && hasUnicode(string)) {
          return castSlice(stringToArray(string), 0, limit);
        }
      }
      return string.split(separator, limit);
    }

    /**
     * Converts `string` to
     * [start case](https://en.wikipedia.org/wiki/Letter_case#Stylistic_or_specialised_usage).
     *
     * @static
     * @memberOf _
     * @since 3.1.0
     * @category String
     * @param {string} [string=''] The string to convert.
     * @returns {string} Returns the start cased string.
     * @example
     *
     * _.startCase('--foo-bar--');
     * // => 'Foo Bar'
     *
     * _.startCase('fooBar');
     * // => 'Foo Bar'
     *
     * _.startCase('__FOO_BAR__');
     * // => 'FOO BAR'
     */
    var startCase = createCompounder(function(result, word, index) {
      return result + (index ? ' ' : '') + upperFirst(word);
    });

    /**
     * Checks if `string` starts with the given target string.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to inspect.
     * @param {string} [target] The string to search for.
     * @param {number} [position=0] The position to search from.
     * @returns {boolean} Returns `true` if `string` starts with `target`,
     *  else `false`.
     * @example
     *
     * _.startsWith('abc', 'a');
     * // => true
     *
     * _.startsWith('abc', 'b');
     * // => false
     *
     * _.startsWith('abc', 'b', 1);
     * // => true
     */
    function startsWith(string, target, position) {
      string = toString(string);
      position = position == null
        ? 0
        : baseClamp(toInteger(position), 0, string.length);

      target = baseToString(target);
      return string.slice(position, position + target.length) == target;
    }

    /**
     * Creates a compiled template function that can interpolate data properties
     * in "interpolate" delimiters, HTML-escape interpolated data properties in
     * "escape" delimiters, and execute JavaScript in "evaluate" delimiters. Data
     * properties may be accessed as free variables in the template. If a setting
     * object is given, it takes precedence over `_.templateSettings` values.
     *
     * **Note:** In the development build `_.template` utilizes
     * [sourceURLs](http://www.html5rocks.com/en/tutorials/developertools/sourcemaps/#toc-sourceurl)
     * for easier debugging.
     *
     * For more information on precompiling templates see
     * [lodash's custom builds documentation](https://lodash.com/custom-builds).
     *
     * For more information on Chrome extension sandboxes see
     * [Chrome's extensions documentation](https://developer.chrome.com/extensions/sandboxingEval).
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category String
     * @param {string} [string=''] The template string.
     * @param {Object} [options={}] The options object.
     * @param {RegExp} [options.escape=_.templateSettings.escape]
     *  The HTML "escape" delimiter.
     * @param {RegExp} [options.evaluate=_.templateSettings.evaluate]
     *  The "evaluate" delimiter.
     * @param {Object} [options.imports=_.templateSettings.imports]
     *  An object to import into the template as free variables.
     * @param {RegExp} [options.interpolate=_.templateSettings.interpolate]
     *  The "interpolate" delimiter.
     * @param {string} [options.sourceURL='lodash.templateSources[n]']
     *  The sourceURL of the compiled template.
     * @param {string} [options.variable='obj']
     *  The data object variable name.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Function} Returns the compiled template function.
     * @example
     *
     * // Use the "interpolate" delimiter to create a compiled template.
     * var compiled = _.template('hello <%= user %>!');
     * compiled({ 'user': 'fred' });
     * // => 'hello fred!'
     *
     * // Use the HTML "escape" delimiter to escape data property values.
     * var compiled = _.template('<b><%- value %></b>');
     * compiled({ 'value': '<script>' });
     * // => '<b>&lt;script&gt;</b>'
     *
     * // Use the "evaluate" delimiter to execute JavaScript and generate HTML.
     * var compiled = _.template('<% _.forEach(users, function(user) { %><li><%- user %></li><% }); %>');
     * compiled({ 'users': ['fred', 'barney'] });
     * // => '<li>fred</li><li>barney</li>'
     *
     * // Use the internal `print` function in "evaluate" delimiters.
     * var compiled = _.template('<% print("hello " + user); %>!');
     * compiled({ 'user': 'barney' });
     * // => 'hello barney!'
     *
     * // Use the ES template literal delimiter as an "interpolate" delimiter.
     * // Disable support by replacing the "interpolate" delimiter.
     * var compiled = _.template('hello ${ user }!');
     * compiled({ 'user': 'pebbles' });
     * // => 'hello pebbles!'
     *
     * // Use backslashes to treat delimiters as plain text.
     * var compiled = _.template('<%= "\\<%- value %\\>" %>');
     * compiled({ 'value': 'ignored' });
     * // => '<%- value %>'
     *
     * // Use the `imports` option to import `jQuery` as `jq`.
     * var text = '<% jq.each(users, function(user) { %><li><%- user %></li><% }); %>';
     * var compiled = _.template(text, { 'imports': { 'jq': jQuery } });
     * compiled({ 'users': ['fred', 'barney'] });
     * // => '<li>fred</li><li>barney</li>'
     *
     * // Use the `sourceURL` option to specify a custom sourceURL for the template.
     * var compiled = _.template('hello <%= user %>!', { 'sourceURL': '/basic/greeting.jst' });
     * compiled(data);
     * // => Find the source of "greeting.jst" under the Sources tab or Resources panel of the web inspector.
     *
     * // Use the `variable` option to ensure a with-statement isn't used in the compiled template.
     * var compiled = _.template('hi <%= data.user %>!', { 'variable': 'data' });
     * compiled.source;
     * // => function(data) {
     * //   var __t, __p = '';
     * //   __p += 'hi ' + ((__t = ( data.user )) == null ? '' : __t) + '!';
     * //   return __p;
     * // }
     *
     * // Use custom template delimiters.
     * _.templateSettings.interpolate = /{{([\s\S]+?)}}/g;
     * var compiled = _.template('hello {{ user }}!');
     * compiled({ 'user': 'mustache' });
     * // => 'hello mustache!'
     *
     * // Use the `source` property to inline compiled templates for meaningful
     * // line numbers in error messages and stack traces.
     * fs.writeFileSync(path.join(process.cwd(), 'jst.js'), '\
     *   var JST = {\
     *     "main": ' + _.template(mainText).source + '\
     *   };\
     * ');
     */
    function template(string, options, guard) {
      // Based on John Resig's `tmpl` implementation
      // (http://ejohn.org/blog/javascript-micro-templating/)
      // and Laura Doktorova's doT.js (https://github.com/olado/doT).
      var settings = lodash.templateSettings;

      if (guard && isIterateeCall(string, options, guard)) {
        options = undefined;
      }
      string = toString(string);
      options = assignInWith({}, options, settings, customDefaultsAssignIn);

      var imports = assignInWith({}, options.imports, settings.imports, customDefaultsAssignIn),
          importsKeys = keys(imports),
          importsValues = baseValues(imports, importsKeys);

      var isEscaping,
          isEvaluating,
          index = 0,
          interpolate = options.interpolate || reNoMatch,
          source = "__p += '";

      // Compile the regexp to match each delimiter.
      var reDelimiters = RegExp(
        (options.escape || reNoMatch).source + '|' +
        interpolate.source + '|' +
        (interpolate === reInterpolate ? reEsTemplate : reNoMatch).source + '|' +
        (options.evaluate || reNoMatch).source + '|$'
      , 'g');

      // Use a sourceURL for easier debugging.
      var sourceURL = '//# sourceURL=' +
        ('sourceURL' in options
          ? options.sourceURL
          : ('lodash.templateSources[' + (++templateCounter) + ']')
        ) + '\n';

      string.replace(reDelimiters, function(match, escapeValue, interpolateValue, esTemplateValue, evaluateValue, offset) {
        interpolateValue || (interpolateValue = esTemplateValue);

        // Escape characters that can't be included in string literals.
        source += string.slice(index, offset).replace(reUnescapedString, escapeStringChar);

        // Replace delimiters with snippets.
        if (escapeValue) {
          isEscaping = true;
          source += "' +\n__e(" + escapeValue + ") +\n'";
        }
        if (evaluateValue) {
          isEvaluating = true;
          source += "';\n" + evaluateValue + ";\n__p += '";
        }
        if (interpolateValue) {
          source += "' +\n((__t = (" + interpolateValue + ")) == null ? '' : __t) +\n'";
        }
        index = offset + match.length;

        // The JS engine embedded in Adobe products needs `match` returned in
        // order to produce the correct `offset` value.
        return match;
      });

      source += "';\n";

      // If `variable` is not specified wrap a with-statement around the generated
      // code to add the data object to the top of the scope chain.
      var variable = options.variable;
      if (!variable) {
        source = 'with (obj) {\n' + source + '\n}\n';
      }
      // Cleanup code by stripping empty strings.
      source = (isEvaluating ? source.replace(reEmptyStringLeading, '') : source)
        .replace(reEmptyStringMiddle, '$1')
        .replace(reEmptyStringTrailing, '$1;');

      // Frame code as the function body.
      source = 'function(' + (variable || 'obj') + ') {\n' +
        (variable
          ? ''
          : 'obj || (obj = {});\n'
        ) +
        "var __t, __p = ''" +
        (isEscaping
           ? ', __e = _.escape'
           : ''
        ) +
        (isEvaluating
          ? ', __j = Array.prototype.join;\n' +
            "function print() { __p += __j.call(arguments, '') }\n"
          : ';\n'
        ) +
        source +
        'return __p\n}';

      var result = attempt(function() {
        return Function(importsKeys, sourceURL + 'return ' + source)
          .apply(undefined, importsValues);
      });

      // Provide the compiled function's source by its `toString` method or
      // the `source` property as a convenience for inlining compiled templates.
      result.source = source;
      if (isError(result)) {
        throw result;
      }
      return result;
    }

    /**
     * Converts `string`, as a whole, to lower case just like
     * [String#toLowerCase](https://mdn.io/toLowerCase).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to convert.
     * @returns {string} Returns the lower cased string.
     * @example
     *
     * _.toLower('--Foo-Bar--');
     * // => '--foo-bar--'
     *
     * _.toLower('fooBar');
     * // => 'foobar'
     *
     * _.toLower('__FOO_BAR__');
     * // => '__foo_bar__'
     */
    function toLower(value) {
      return toString(value).toLowerCase();
    }

    /**
     * Converts `string`, as a whole, to upper case just like
     * [String#toUpperCase](https://mdn.io/toUpperCase).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to convert.
     * @returns {string} Returns the upper cased string.
     * @example
     *
     * _.toUpper('--foo-bar--');
     * // => '--FOO-BAR--'
     *
     * _.toUpper('fooBar');
     * // => 'FOOBAR'
     *
     * _.toUpper('__foo_bar__');
     * // => '__FOO_BAR__'
     */
    function toUpper(value) {
      return toString(value).toUpperCase();
    }

    /**
     * Removes leading and trailing whitespace or specified characters from `string`.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to trim.
     * @param {string} [chars=whitespace] The characters to trim.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {string} Returns the trimmed string.
     * @example
     *
     * _.trim('  abc  ');
     * // => 'abc'
     *
     * _.trim('-_-abc-_-', '_-');
     * // => 'abc'
     *
     * _.map(['  foo  ', '  bar  '], _.trim);
     * // => ['foo', 'bar']
     */
    function trim(string, chars, guard) {
      string = toString(string);
      if (string && (guard || chars === undefined)) {
        return string.replace(reTrim, '');
      }
      if (!string || !(chars = baseToString(chars))) {
        return string;
      }
      var strSymbols = stringToArray(string),
          chrSymbols = stringToArray(chars),
          start = charsStartIndex(strSymbols, chrSymbols),
          end = charsEndIndex(strSymbols, chrSymbols) + 1;

      return castSlice(strSymbols, start, end).join('');
    }

    /**
     * Removes trailing whitespace or specified characters from `string`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to trim.
     * @param {string} [chars=whitespace] The characters to trim.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {string} Returns the trimmed string.
     * @example
     *
     * _.trimEnd('  abc  ');
     * // => '  abc'
     *
     * _.trimEnd('-_-abc-_-', '_-');
     * // => '-_-abc'
     */
    function trimEnd(string, chars, guard) {
      string = toString(string);
      if (string && (guard || chars === undefined)) {
        return string.replace(reTrimEnd, '');
      }
      if (!string || !(chars = baseToString(chars))) {
        return string;
      }
      var strSymbols = stringToArray(string),
          end = charsEndIndex(strSymbols, stringToArray(chars)) + 1;

      return castSlice(strSymbols, 0, end).join('');
    }

    /**
     * Removes leading whitespace or specified characters from `string`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to trim.
     * @param {string} [chars=whitespace] The characters to trim.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {string} Returns the trimmed string.
     * @example
     *
     * _.trimStart('  abc  ');
     * // => 'abc  '
     *
     * _.trimStart('-_-abc-_-', '_-');
     * // => 'abc-_-'
     */
    function trimStart(string, chars, guard) {
      string = toString(string);
      if (string && (guard || chars === undefined)) {
        return string.replace(reTrimStart, '');
      }
      if (!string || !(chars = baseToString(chars))) {
        return string;
      }
      var strSymbols = stringToArray(string),
          start = charsStartIndex(strSymbols, stringToArray(chars));

      return castSlice(strSymbols, start).join('');
    }

    /**
     * Truncates `string` if it's longer than the given maximum string length.
     * The last characters of the truncated string are replaced with the omission
     * string which defaults to "...".
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to truncate.
     * @param {Object} [options={}] The options object.
     * @param {number} [options.length=30] The maximum string length.
     * @param {string} [options.omission='...'] The string to indicate text is omitted.
     * @param {RegExp|string} [options.separator] The separator pattern to truncate to.
     * @returns {string} Returns the truncated string.
     * @example
     *
     * _.truncate('hi-diddly-ho there, neighborino');
     * // => 'hi-diddly-ho there, neighbo...'
     *
     * _.truncate('hi-diddly-ho there, neighborino', {
     *   'length': 24,
     *   'separator': ' '
     * });
     * // => 'hi-diddly-ho there,...'
     *
     * _.truncate('hi-diddly-ho there, neighborino', {
     *   'length': 24,
     *   'separator': /,? +/
     * });
     * // => 'hi-diddly-ho there...'
     *
     * _.truncate('hi-diddly-ho there, neighborino', {
     *   'omission': ' [...]'
     * });
     * // => 'hi-diddly-ho there, neig [...]'
     */
    function truncate(string, options) {
      var length = DEFAULT_TRUNC_LENGTH,
          omission = DEFAULT_TRUNC_OMISSION;

      if (isObject(options)) {
        var separator = 'separator' in options ? options.separator : separator;
        length = 'length' in options ? toInteger(options.length) : length;
        omission = 'omission' in options ? baseToString(options.omission) : omission;
      }
      string = toString(string);

      var strLength = string.length;
      if (hasUnicode(string)) {
        var strSymbols = stringToArray(string);
        strLength = strSymbols.length;
      }
      if (length >= strLength) {
        return string;
      }
      var end = length - stringSize(omission);
      if (end < 1) {
        return omission;
      }
      var result = strSymbols
        ? castSlice(strSymbols, 0, end).join('')
        : string.slice(0, end);

      if (separator === undefined) {
        return result + omission;
      }
      if (strSymbols) {
        end += (result.length - end);
      }
      if (isRegExp(separator)) {
        if (string.slice(end).search(separator)) {
          var match,
              substring = result;

          if (!separator.global) {
            separator = RegExp(separator.source, toString(reFlags.exec(separator)) + 'g');
          }
          separator.lastIndex = 0;
          while ((match = separator.exec(substring))) {
            var newEnd = match.index;
          }
          result = result.slice(0, newEnd === undefined ? end : newEnd);
        }
      } else if (string.indexOf(baseToString(separator), end) != end) {
        var index = result.lastIndexOf(separator);
        if (index > -1) {
          result = result.slice(0, index);
        }
      }
      return result + omission;
    }

    /**
     * The inverse of `_.escape`; this method converts the HTML entities
     * `&amp;`, `&lt;`, `&gt;`, `&quot;`, and `&#39;` in `string` to
     * their corresponding characters.
     *
     * **Note:** No other HTML entities are unescaped. To unescape additional
     * HTML entities use a third-party library like [_he_](https://mths.be/he).
     *
     * @static
     * @memberOf _
     * @since 0.6.0
     * @category String
     * @param {string} [string=''] The string to unescape.
     * @returns {string} Returns the unescaped string.
     * @example
     *
     * _.unescape('fred, barney, &amp; pebbles');
     * // => 'fred, barney, & pebbles'
     */
    function unescape(string) {
      string = toString(string);
      return (string && reHasEscapedHtml.test(string))
        ? string.replace(reEscapedHtml, unescapeHtmlChar)
        : string;
    }

    /**
     * Converts `string`, as space separated words, to upper case.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to convert.
     * @returns {string} Returns the upper cased string.
     * @example
     *
     * _.upperCase('--foo-bar');
     * // => 'FOO BAR'
     *
     * _.upperCase('fooBar');
     * // => 'FOO BAR'
     *
     * _.upperCase('__foo_bar__');
     * // => 'FOO BAR'
     */
    var upperCase = createCompounder(function(result, word, index) {
      return result + (index ? ' ' : '') + word.toUpperCase();
    });

    /**
     * Converts the first character of `string` to upper case.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category String
     * @param {string} [string=''] The string to convert.
     * @returns {string} Returns the converted string.
     * @example
     *
     * _.upperFirst('fred');
     * // => 'Fred'
     *
     * _.upperFirst('FRED');
     * // => 'FRED'
     */
    var upperFirst = createCaseFirst('toUpperCase');

    /**
     * Splits `string` into an array of its words.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category String
     * @param {string} [string=''] The string to inspect.
     * @param {RegExp|string} [pattern] The pattern to match words.
     * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
     * @returns {Array} Returns the words of `string`.
     * @example
     *
     * _.words('fred, barney, & pebbles');
     * // => ['fred', 'barney', 'pebbles']
     *
     * _.words('fred, barney, & pebbles', /[^, ]+/g);
     * // => ['fred', 'barney', '&', 'pebbles']
     */
    function words(string, pattern, guard) {
      string = toString(string);
      pattern = guard ? undefined : pattern;

      if (pattern === undefined) {
        return hasUnicodeWord(string) ? unicodeWords(string) : asciiWords(string);
      }
      return string.match(pattern) || [];
    }

    /*------------------------------------------------------------------------*/

    /**
     * Attempts to invoke `func`, returning either the result or the caught error
     * object. Any additional arguments are provided to `func` when it's invoked.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Util
     * @param {Function} func The function to attempt.
     * @param {...*} [args] The arguments to invoke `func` with.
     * @returns {*} Returns the `func` result or error object.
     * @example
     *
     * // Avoid throwing errors for invalid selectors.
     * var elements = _.attempt(function(selector) {
     *   return document.querySelectorAll(selector);
     * }, '>_>');
     *
     * if (_.isError(elements)) {
     *   elements = [];
     * }
     */
    var attempt = baseRest(function(func, args) {
      try {
        return apply(func, undefined, args);
      } catch (e) {
        return isError(e) ? e : new Error(e);
      }
    });

    /**
     * Binds methods of an object to the object itself, overwriting the existing
     * method.
     *
     * **Note:** This method doesn't set the "length" property of bound functions.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Util
     * @param {Object} object The object to bind and assign the bound methods to.
     * @param {...(string|string[])} methodNames The object method names to bind.
     * @returns {Object} Returns `object`.
     * @example
     *
     * var view = {
     *   'label': 'docs',
     *   'click': function() {
     *     console.log('clicked ' + this.label);
     *   }
     * };
     *
     * _.bindAll(view, ['click']);
     * jQuery(element).on('click', view.click);
     * // => Logs 'clicked docs' when clicked.
     */
    var bindAll = flatRest(function(object, methodNames) {
      arrayEach(methodNames, function(key) {
        key = toKey(key);
        baseAssignValue(object, key, bind(object[key], object));
      });
      return object;
    });

    /**
     * Creates a function that iterates over `pairs` and invokes the corresponding
     * function of the first predicate to return truthy. The predicate-function
     * pairs are invoked with the `this` binding and arguments of the created
     * function.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Util
     * @param {Array} pairs The predicate-function pairs.
     * @returns {Function} Returns the new composite function.
     * @example
     *
     * var func = _.cond([
     *   [_.matches({ 'a': 1 }),           _.constant('matches A')],
     *   [_.conforms({ 'b': _.isNumber }), _.constant('matches B')],
     *   [_.stubTrue,                      _.constant('no match')]
     * ]);
     *
     * func({ 'a': 1, 'b': 2 });
     * // => 'matches A'
     *
     * func({ 'a': 0, 'b': 1 });
     * // => 'matches B'
     *
     * func({ 'a': '1', 'b': '2' });
     * // => 'no match'
     */
    function cond(pairs) {
      var length = pairs == null ? 0 : pairs.length,
          toIteratee = getIteratee();

      pairs = !length ? [] : arrayMap(pairs, function(pair) {
        if (typeof pair[1] != 'function') {
          throw new TypeError(FUNC_ERROR_TEXT);
        }
        return [toIteratee(pair[0]), pair[1]];
      });

      return baseRest(function(args) {
        var index = -1;
        while (++index < length) {
          var pair = pairs[index];
          if (apply(pair[0], this, args)) {
            return apply(pair[1], this, args);
          }
        }
      });
    }

    /**
     * Creates a function that invokes the predicate properties of `source` with
     * the corresponding property values of a given object, returning `true` if
     * all predicates return truthy, else `false`.
     *
     * **Note:** The created function is equivalent to `_.conformsTo` with
     * `source` partially applied.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Util
     * @param {Object} source The object of property predicates to conform to.
     * @returns {Function} Returns the new spec function.
     * @example
     *
     * var objects = [
     *   { 'a': 2, 'b': 1 },
     *   { 'a': 1, 'b': 2 }
     * ];
     *
     * _.filter(objects, _.conforms({ 'b': function(n) { return n > 1; } }));
     * // => [{ 'a': 1, 'b': 2 }]
     */
    function conforms(source) {
      return baseConforms(baseClone(source, CLONE_DEEP_FLAG));
    }

    /**
     * Creates a function that returns `value`.
     *
     * @static
     * @memberOf _
     * @since 2.4.0
     * @category Util
     * @param {*} value The value to return from the new function.
     * @returns {Function} Returns the new constant function.
     * @example
     *
     * var objects = _.times(2, _.constant({ 'a': 1 }));
     *
     * console.log(objects);
     * // => [{ 'a': 1 }, { 'a': 1 }]
     *
     * console.log(objects[0] === objects[1]);
     * // => true
     */
    function constant(value) {
      return function() {
        return value;
      };
    }

    /**
     * Checks `value` to determine whether a default value should be returned in
     * its place. The `defaultValue` is returned if `value` is `NaN`, `null`,
     * or `undefined`.
     *
     * @static
     * @memberOf _
     * @since 4.14.0
     * @category Util
     * @param {*} value The value to check.
     * @param {*} defaultValue The default value.
     * @returns {*} Returns the resolved value.
     * @example
     *
     * _.defaultTo(1, 10);
     * // => 1
     *
     * _.defaultTo(undefined, 10);
     * // => 10
     */
    function defaultTo(value, defaultValue) {
      return (value == null || value !== value) ? defaultValue : value;
    }

    /**
     * Creates a function that returns the result of invoking the given functions
     * with the `this` binding of the created function, where each successive
     * invocation is supplied the return value of the previous.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Util
     * @param {...(Function|Function[])} [funcs] The functions to invoke.
     * @returns {Function} Returns the new composite function.
     * @see _.flowRight
     * @example
     *
     * function square(n) {
     *   return n * n;
     * }
     *
     * var addSquare = _.flow([_.add, square]);
     * addSquare(1, 2);
     * // => 9
     */
    var flow = createFlow();

    /**
     * This method is like `_.flow` except that it creates a function that
     * invokes the given functions from right to left.
     *
     * @static
     * @since 3.0.0
     * @memberOf _
     * @category Util
     * @param {...(Function|Function[])} [funcs] The functions to invoke.
     * @returns {Function} Returns the new composite function.
     * @see _.flow
     * @example
     *
     * function square(n) {
     *   return n * n;
     * }
     *
     * var addSquare = _.flowRight([square, _.add]);
     * addSquare(1, 2);
     * // => 9
     */
    var flowRight = createFlow(true);

    /**
     * This method returns the first argument it receives.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Util
     * @param {*} value Any value.
     * @returns {*} Returns `value`.
     * @example
     *
     * var object = { 'a': 1 };
     *
     * console.log(_.identity(object) === object);
     * // => true
     */
    function identity(value) {
      return value;
    }

    /**
     * Creates a function that invokes `func` with the arguments of the created
     * function. If `func` is a property name, the created function returns the
     * property value for a given element. If `func` is an array or object, the
     * created function returns `true` for elements that contain the equivalent
     * source properties, otherwise it returns `false`.
     *
     * @static
     * @since 4.0.0
     * @memberOf _
     * @category Util
     * @param {*} [func=_.identity] The value to convert to a callback.
     * @returns {Function} Returns the callback.
     * @example
     *
     * var users = [
     *   { 'user': 'barney', 'age': 36, 'active': true },
     *   { 'user': 'fred',   'age': 40, 'active': false }
     * ];
     *
     * // The `_.matches` iteratee shorthand.
     * _.filter(users, _.iteratee({ 'user': 'barney', 'active': true }));
     * // => [{ 'user': 'barney', 'age': 36, 'active': true }]
     *
     * // The `_.matchesProperty` iteratee shorthand.
     * _.filter(users, _.iteratee(['user', 'fred']));
     * // => [{ 'user': 'fred', 'age': 40 }]
     *
     * // The `_.property` iteratee shorthand.
     * _.map(users, _.iteratee('user'));
     * // => ['barney', 'fred']
     *
     * // Create custom iteratee shorthands.
     * _.iteratee = _.wrap(_.iteratee, function(iteratee, func) {
     *   return !_.isRegExp(func) ? iteratee(func) : function(string) {
     *     return func.test(string);
     *   };
     * });
     *
     * _.filter(['abc', 'def'], /ef/);
     * // => ['def']
     */
    function iteratee(func) {
      return baseIteratee(typeof func == 'function' ? func : baseClone(func, CLONE_DEEP_FLAG));
    }

    /**
     * Creates a function that performs a partial deep comparison between a given
     * object and `source`, returning `true` if the given object has equivalent
     * property values, else `false`.
     *
     * **Note:** The created function is equivalent to `_.isMatch` with `source`
     * partially applied.
     *
     * Partial comparisons will match empty array and empty object `source`
     * values against any array or object value, respectively. See `_.isEqual`
     * for a list of supported value comparisons.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Util
     * @param {Object} source The object of property values to match.
     * @returns {Function} Returns the new spec function.
     * @example
     *
     * var objects = [
     *   { 'a': 1, 'b': 2, 'c': 3 },
     *   { 'a': 4, 'b': 5, 'c': 6 }
     * ];
     *
     * _.filter(objects, _.matches({ 'a': 4, 'c': 6 }));
     * // => [{ 'a': 4, 'b': 5, 'c': 6 }]
     */
    function matches(source) {
      return baseMatches(baseClone(source, CLONE_DEEP_FLAG));
    }

    /**
     * Creates a function that performs a partial deep comparison between the
     * value at `path` of a given object to `srcValue`, returning `true` if the
     * object value is equivalent, else `false`.
     *
     * **Note:** Partial comparisons will match empty array and empty object
     * `srcValue` values against any array or object value, respectively. See
     * `_.isEqual` for a list of supported value comparisons.
     *
     * @static
     * @memberOf _
     * @since 3.2.0
     * @category Util
     * @param {Array|string} path The path of the property to get.
     * @param {*} srcValue The value to match.
     * @returns {Function} Returns the new spec function.
     * @example
     *
     * var objects = [
     *   { 'a': 1, 'b': 2, 'c': 3 },
     *   { 'a': 4, 'b': 5, 'c': 6 }
     * ];
     *
     * _.find(objects, _.matchesProperty('a', 4));
     * // => { 'a': 4, 'b': 5, 'c': 6 }
     */
    function matchesProperty(path, srcValue) {
      return baseMatchesProperty(path, baseClone(srcValue, CLONE_DEEP_FLAG));
    }

    /**
     * Creates a function that invokes the method at `path` of a given object.
     * Any additional arguments are provided to the invoked method.
     *
     * @static
     * @memberOf _
     * @since 3.7.0
     * @category Util
     * @param {Array|string} path The path of the method to invoke.
     * @param {...*} [args] The arguments to invoke the method with.
     * @returns {Function} Returns the new invoker function.
     * @example
     *
     * var objects = [
     *   { 'a': { 'b': _.constant(2) } },
     *   { 'a': { 'b': _.constant(1) } }
     * ];
     *
     * _.map(objects, _.method('a.b'));
     * // => [2, 1]
     *
     * _.map(objects, _.method(['a', 'b']));
     * // => [2, 1]
     */
    var method = baseRest(function(path, args) {
      return function(object) {
        return baseInvoke(object, path, args);
      };
    });

    /**
     * The opposite of `_.method`; this method creates a function that invokes
     * the method at a given path of `object`. Any additional arguments are
     * provided to the invoked method.
     *
     * @static
     * @memberOf _
     * @since 3.7.0
     * @category Util
     * @param {Object} object The object to query.
     * @param {...*} [args] The arguments to invoke the method with.
     * @returns {Function} Returns the new invoker function.
     * @example
     *
     * var array = _.times(3, _.constant),
     *     object = { 'a': array, 'b': array, 'c': array };
     *
     * _.map(['a[2]', 'c[0]'], _.methodOf(object));
     * // => [2, 0]
     *
     * _.map([['a', '2'], ['c', '0']], _.methodOf(object));
     * // => [2, 0]
     */
    var methodOf = baseRest(function(object, args) {
      return function(path) {
        return baseInvoke(object, path, args);
      };
    });

    /**
     * Adds all own enumerable string keyed function properties of a source
     * object to the destination object. If `object` is a function, then methods
     * are added to its prototype as well.
     *
     * **Note:** Use `_.runInContext` to create a pristine `lodash` function to
     * avoid conflicts caused by modifying the original.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Util
     * @param {Function|Object} [object=lodash] The destination object.
     * @param {Object} source The object of functions to add.
     * @param {Object} [options={}] The options object.
     * @param {boolean} [options.chain=true] Specify whether mixins are chainable.
     * @returns {Function|Object} Returns `object`.
     * @example
     *
     * function vowels(string) {
     *   return _.filter(string, function(v) {
     *     return /[aeiou]/i.test(v);
     *   });
     * }
     *
     * _.mixin({ 'vowels': vowels });
     * _.vowels('fred');
     * // => ['e']
     *
     * _('fred').vowels().value();
     * // => ['e']
     *
     * _.mixin({ 'vowels': vowels }, { 'chain': false });
     * _('fred').vowels();
     * // => ['e']
     */
    function mixin(object, source, options) {
      var props = keys(source),
          methodNames = baseFunctions(source, props);

      if (options == null &&
          !(isObject(source) && (methodNames.length || !props.length))) {
        options = source;
        source = object;
        object = this;
        methodNames = baseFunctions(source, keys(source));
      }
      var chain = !(isObject(options) && 'chain' in options) || !!options.chain,
          isFunc = isFunction(object);

      arrayEach(methodNames, function(methodName) {
        var func = source[methodName];
        object[methodName] = func;
        if (isFunc) {
          object.prototype[methodName] = function() {
            var chainAll = this.__chain__;
            if (chain || chainAll) {
              var result = object(this.__wrapped__),
                  actions = result.__actions__ = copyArray(this.__actions__);

              actions.push({ 'func': func, 'args': arguments, 'thisArg': object });
              result.__chain__ = chainAll;
              return result;
            }
            return func.apply(object, arrayPush([this.value()], arguments));
          };
        }
      });

      return object;
    }

    /**
     * Reverts the `_` variable to its previous value and returns a reference to
     * the `lodash` function.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Util
     * @returns {Function} Returns the `lodash` function.
     * @example
     *
     * var lodash = _.noConflict();
     */
    function noConflict() {
      if (root._ === this) {
        root._ = oldDash;
      }
      return this;
    }

    /**
     * This method returns `undefined`.
     *
     * @static
     * @memberOf _
     * @since 2.3.0
     * @category Util
     * @example
     *
     * _.times(2, _.noop);
     * // => [undefined, undefined]
     */
    function noop() {
      // No operation performed.
    }

    /**
     * Creates a function that gets the argument at index `n`. If `n` is negative,
     * the nth argument from the end is returned.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Util
     * @param {number} [n=0] The index of the argument to return.
     * @returns {Function} Returns the new pass-thru function.
     * @example
     *
     * var func = _.nthArg(1);
     * func('a', 'b', 'c', 'd');
     * // => 'b'
     *
     * var func = _.nthArg(-2);
     * func('a', 'b', 'c', 'd');
     * // => 'c'
     */
    function nthArg(n) {
      n = toInteger(n);
      return baseRest(function(args) {
        return baseNth(args, n);
      });
    }

    /**
     * Creates a function that invokes `iteratees` with the arguments it receives
     * and returns their results.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Util
     * @param {...(Function|Function[])} [iteratees=[_.identity]]
     *  The iteratees to invoke.
     * @returns {Function} Returns the new function.
     * @example
     *
     * var func = _.over([Math.max, Math.min]);
     *
     * func(1, 2, 3, 4);
     * // => [4, 1]
     */
    var over = createOver(arrayMap);

    /**
     * Creates a function that checks if **all** of the `predicates` return
     * truthy when invoked with the arguments it receives.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Util
     * @param {...(Function|Function[])} [predicates=[_.identity]]
     *  The predicates to check.
     * @returns {Function} Returns the new function.
     * @example
     *
     * var func = _.overEvery([Boolean, isFinite]);
     *
     * func('1');
     * // => true
     *
     * func(null);
     * // => false
     *
     * func(NaN);
     * // => false
     */
    var overEvery = createOver(arrayEvery);

    /**
     * Creates a function that checks if **any** of the `predicates` return
     * truthy when invoked with the arguments it receives.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Util
     * @param {...(Function|Function[])} [predicates=[_.identity]]
     *  The predicates to check.
     * @returns {Function} Returns the new function.
     * @example
     *
     * var func = _.overSome([Boolean, isFinite]);
     *
     * func('1');
     * // => true
     *
     * func(null);
     * // => true
     *
     * func(NaN);
     * // => false
     */
    var overSome = createOver(arraySome);

    /**
     * Creates a function that returns the value at `path` of a given object.
     *
     * @static
     * @memberOf _
     * @since 2.4.0
     * @category Util
     * @param {Array|string} path The path of the property to get.
     * @returns {Function} Returns the new accessor function.
     * @example
     *
     * var objects = [
     *   { 'a': { 'b': 2 } },
     *   { 'a': { 'b': 1 } }
     * ];
     *
     * _.map(objects, _.property('a.b'));
     * // => [2, 1]
     *
     * _.map(_.sortBy(objects, _.property(['a', 'b'])), 'a.b');
     * // => [1, 2]
     */
    function property(path) {
      return isKey(path) ? baseProperty(toKey(path)) : basePropertyDeep(path);
    }

    /**
     * The opposite of `_.property`; this method creates a function that returns
     * the value at a given path of `object`.
     *
     * @static
     * @memberOf _
     * @since 3.0.0
     * @category Util
     * @param {Object} object The object to query.
     * @returns {Function} Returns the new accessor function.
     * @example
     *
     * var array = [0, 1, 2],
     *     object = { 'a': array, 'b': array, 'c': array };
     *
     * _.map(['a[2]', 'c[0]'], _.propertyOf(object));
     * // => [2, 0]
     *
     * _.map([['a', '2'], ['c', '0']], _.propertyOf(object));
     * // => [2, 0]
     */
    function propertyOf(object) {
      return function(path) {
        return object == null ? undefined : baseGet(object, path);
      };
    }

    /**
     * Creates an array of numbers (positive and/or negative) progressing from
     * `start` up to, but not including, `end`. A step of `-1` is used if a negative
     * `start` is specified without an `end` or `step`. If `end` is not specified,
     * it's set to `start` with `start` then set to `0`.
     *
     * **Note:** JavaScript follows the IEEE-754 standard for resolving
     * floating-point values which can produce unexpected results.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Util
     * @param {number} [start=0] The start of the range.
     * @param {number} end The end of the range.
     * @param {number} [step=1] The value to increment or decrement by.
     * @returns {Array} Returns the range of numbers.
     * @see _.inRange, _.rangeRight
     * @example
     *
     * _.range(4);
     * // => [0, 1, 2, 3]
     *
     * _.range(-4);
     * // => [0, -1, -2, -3]
     *
     * _.range(1, 5);
     * // => [1, 2, 3, 4]
     *
     * _.range(0, 20, 5);
     * // => [0, 5, 10, 15]
     *
     * _.range(0, -4, -1);
     * // => [0, -1, -2, -3]
     *
     * _.range(1, 4, 0);
     * // => [1, 1, 1]
     *
     * _.range(0);
     * // => []
     */
    var range = createRange();

    /**
     * This method is like `_.range` except that it populates values in
     * descending order.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Util
     * @param {number} [start=0] The start of the range.
     * @param {number} end The end of the range.
     * @param {number} [step=1] The value to increment or decrement by.
     * @returns {Array} Returns the range of numbers.
     * @see _.inRange, _.range
     * @example
     *
     * _.rangeRight(4);
     * // => [3, 2, 1, 0]
     *
     * _.rangeRight(-4);
     * // => [-3, -2, -1, 0]
     *
     * _.rangeRight(1, 5);
     * // => [4, 3, 2, 1]
     *
     * _.rangeRight(0, 20, 5);
     * // => [15, 10, 5, 0]
     *
     * _.rangeRight(0, -4, -1);
     * // => [-3, -2, -1, 0]
     *
     * _.rangeRight(1, 4, 0);
     * // => [1, 1, 1]
     *
     * _.rangeRight(0);
     * // => []
     */
    var rangeRight = createRange(true);

    /**
     * This method returns a new empty array.
     *
     * @static
     * @memberOf _
     * @since 4.13.0
     * @category Util
     * @returns {Array} Returns the new empty array.
     * @example
     *
     * var arrays = _.times(2, _.stubArray);
     *
     * console.log(arrays);
     * // => [[], []]
     *
     * console.log(arrays[0] === arrays[1]);
     * // => false
     */
    function stubArray() {
      return [];
    }

    /**
     * This method returns `false`.
     *
     * @static
     * @memberOf _
     * @since 4.13.0
     * @category Util
     * @returns {boolean} Returns `false`.
     * @example
     *
     * _.times(2, _.stubFalse);
     * // => [false, false]
     */
    function stubFalse() {
      return false;
    }

    /**
     * This method returns a new empty object.
     *
     * @static
     * @memberOf _
     * @since 4.13.0
     * @category Util
     * @returns {Object} Returns the new empty object.
     * @example
     *
     * var objects = _.times(2, _.stubObject);
     *
     * console.log(objects);
     * // => [{}, {}]
     *
     * console.log(objects[0] === objects[1]);
     * // => false
     */
    function stubObject() {
      return {};
    }

    /**
     * This method returns an empty string.
     *
     * @static
     * @memberOf _
     * @since 4.13.0
     * @category Util
     * @returns {string} Returns the empty string.
     * @example
     *
     * _.times(2, _.stubString);
     * // => ['', '']
     */
    function stubString() {
      return '';
    }

    /**
     * This method returns `true`.
     *
     * @static
     * @memberOf _
     * @since 4.13.0
     * @category Util
     * @returns {boolean} Returns `true`.
     * @example
     *
     * _.times(2, _.stubTrue);
     * // => [true, true]
     */
    function stubTrue() {
      return true;
    }

    /**
     * Invokes the iteratee `n` times, returning an array of the results of
     * each invocation. The iteratee is invoked with one argument; (index).
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Util
     * @param {number} n The number of times to invoke `iteratee`.
     * @param {Function} [iteratee=_.identity] The function invoked per iteration.
     * @returns {Array} Returns the array of results.
     * @example
     *
     * _.times(3, String);
     * // => ['0', '1', '2']
     *
     *  _.times(4, _.constant(0));
     * // => [0, 0, 0, 0]
     */
    function times(n, iteratee) {
      n = toInteger(n);
      if (n < 1 || n > MAX_SAFE_INTEGER) {
        return [];
      }
      var index = MAX_ARRAY_LENGTH,
          length = nativeMin(n, MAX_ARRAY_LENGTH);

      iteratee = getIteratee(iteratee);
      n -= MAX_ARRAY_LENGTH;

      var result = baseTimes(length, iteratee);
      while (++index < n) {
        iteratee(index);
      }
      return result;
    }

    /**
     * Converts `value` to a property path array.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Util
     * @param {*} value The value to convert.
     * @returns {Array} Returns the new property path array.
     * @example
     *
     * _.toPath('a.b.c');
     * // => ['a', 'b', 'c']
     *
     * _.toPath('a[0].b.c');
     * // => ['a', '0', 'b', 'c']
     */
    function toPath(value) {
      if (isArray(value)) {
        return arrayMap(value, toKey);
      }
      return isSymbol(value) ? [value] : copyArray(stringToPath(toString(value)));
    }

    /**
     * Generates a unique ID. If `prefix` is given, the ID is appended to it.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Util
     * @param {string} [prefix=''] The value to prefix the ID with.
     * @returns {string} Returns the unique ID.
     * @example
     *
     * _.uniqueId('contact_');
     * // => 'contact_104'
     *
     * _.uniqueId();
     * // => '105'
     */
    function uniqueId(prefix) {
      var id = ++idCounter;
      return toString(prefix) + id;
    }

    /*------------------------------------------------------------------------*/

    /**
     * Adds two numbers.
     *
     * @static
     * @memberOf _
     * @since 3.4.0
     * @category Math
     * @param {number} augend The first number in an addition.
     * @param {number} addend The second number in an addition.
     * @returns {number} Returns the total.
     * @example
     *
     * _.add(6, 4);
     * // => 10
     */
    var add = createMathOperation(function(augend, addend) {
      return augend + addend;
    }, 0);

    /**
     * Computes `number` rounded up to `precision`.
     *
     * @static
     * @memberOf _
     * @since 3.10.0
     * @category Math
     * @param {number} number The number to round up.
     * @param {number} [precision=0] The precision to round up to.
     * @returns {number} Returns the rounded up number.
     * @example
     *
     * _.ceil(4.006);
     * // => 5
     *
     * _.ceil(6.004, 2);
     * // => 6.01
     *
     * _.ceil(6040, -2);
     * // => 6100
     */
    var ceil = createRound('ceil');

    /**
     * Divide two numbers.
     *
     * @static
     * @memberOf _
     * @since 4.7.0
     * @category Math
     * @param {number} dividend The first number in a division.
     * @param {number} divisor The second number in a division.
     * @returns {number} Returns the quotient.
     * @example
     *
     * _.divide(6, 4);
     * // => 1.5
     */
    var divide = createMathOperation(function(dividend, divisor) {
      return dividend / divisor;
    }, 1);

    /**
     * Computes `number` rounded down to `precision`.
     *
     * @static
     * @memberOf _
     * @since 3.10.0
     * @category Math
     * @param {number} number The number to round down.
     * @param {number} [precision=0] The precision to round down to.
     * @returns {number} Returns the rounded down number.
     * @example
     *
     * _.floor(4.006);
     * // => 4
     *
     * _.floor(0.046, 2);
     * // => 0.04
     *
     * _.floor(4060, -2);
     * // => 4000
     */
    var floor = createRound('floor');

    /**
     * Computes the maximum value of `array`. If `array` is empty or falsey,
     * `undefined` is returned.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Math
     * @param {Array} array The array to iterate over.
     * @returns {*} Returns the maximum value.
     * @example
     *
     * _.max([4, 2, 8, 6]);
     * // => 8
     *
     * _.max([]);
     * // => undefined
     */
    function max(array) {
      return (array && array.length)
        ? baseExtremum(array, identity, baseGt)
        : undefined;
    }

    /**
     * This method is like `_.max` except that it accepts `iteratee` which is
     * invoked for each element in `array` to generate the criterion by which
     * the value is ranked. The iteratee is invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Math
     * @param {Array} array The array to iterate over.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {*} Returns the maximum value.
     * @example
     *
     * var objects = [{ 'n': 1 }, { 'n': 2 }];
     *
     * _.maxBy(objects, function(o) { return o.n; });
     * // => { 'n': 2 }
     *
     * // The `_.property` iteratee shorthand.
     * _.maxBy(objects, 'n');
     * // => { 'n': 2 }
     */
    function maxBy(array, iteratee) {
      return (array && array.length)
        ? baseExtremum(array, getIteratee(iteratee, 2), baseGt)
        : undefined;
    }

    /**
     * Computes the mean of the values in `array`.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Math
     * @param {Array} array The array to iterate over.
     * @returns {number} Returns the mean.
     * @example
     *
     * _.mean([4, 2, 8, 6]);
     * // => 5
     */
    function mean(array) {
      return baseMean(array, identity);
    }

    /**
     * This method is like `_.mean` except that it accepts `iteratee` which is
     * invoked for each element in `array` to generate the value to be averaged.
     * The iteratee is invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 4.7.0
     * @category Math
     * @param {Array} array The array to iterate over.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {number} Returns the mean.
     * @example
     *
     * var objects = [{ 'n': 4 }, { 'n': 2 }, { 'n': 8 }, { 'n': 6 }];
     *
     * _.meanBy(objects, function(o) { return o.n; });
     * // => 5
     *
     * // The `_.property` iteratee shorthand.
     * _.meanBy(objects, 'n');
     * // => 5
     */
    function meanBy(array, iteratee) {
      return baseMean(array, getIteratee(iteratee, 2));
    }

    /**
     * Computes the minimum value of `array`. If `array` is empty or falsey,
     * `undefined` is returned.
     *
     * @static
     * @since 0.1.0
     * @memberOf _
     * @category Math
     * @param {Array} array The array to iterate over.
     * @returns {*} Returns the minimum value.
     * @example
     *
     * _.min([4, 2, 8, 6]);
     * // => 2
     *
     * _.min([]);
     * // => undefined
     */
    function min(array) {
      return (array && array.length)
        ? baseExtremum(array, identity, baseLt)
        : undefined;
    }

    /**
     * This method is like `_.min` except that it accepts `iteratee` which is
     * invoked for each element in `array` to generate the criterion by which
     * the value is ranked. The iteratee is invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Math
     * @param {Array} array The array to iterate over.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {*} Returns the minimum value.
     * @example
     *
     * var objects = [{ 'n': 1 }, { 'n': 2 }];
     *
     * _.minBy(objects, function(o) { return o.n; });
     * // => { 'n': 1 }
     *
     * // The `_.property` iteratee shorthand.
     * _.minBy(objects, 'n');
     * // => { 'n': 1 }
     */
    function minBy(array, iteratee) {
      return (array && array.length)
        ? baseExtremum(array, getIteratee(iteratee, 2), baseLt)
        : undefined;
    }

    /**
     * Multiply two numbers.
     *
     * @static
     * @memberOf _
     * @since 4.7.0
     * @category Math
     * @param {number} multiplier The first number in a multiplication.
     * @param {number} multiplicand The second number in a multiplication.
     * @returns {number} Returns the product.
     * @example
     *
     * _.multiply(6, 4);
     * // => 24
     */
    var multiply = createMathOperation(function(multiplier, multiplicand) {
      return multiplier * multiplicand;
    }, 1);

    /**
     * Computes `number` rounded to `precision`.
     *
     * @static
     * @memberOf _
     * @since 3.10.0
     * @category Math
     * @param {number} number The number to round.
     * @param {number} [precision=0] The precision to round to.
     * @returns {number} Returns the rounded number.
     * @example
     *
     * _.round(4.006);
     * // => 4
     *
     * _.round(4.006, 2);
     * // => 4.01
     *
     * _.round(4060, -2);
     * // => 4100
     */
    var round = createRound('round');

    /**
     * Subtract two numbers.
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Math
     * @param {number} minuend The first number in a subtraction.
     * @param {number} subtrahend The second number in a subtraction.
     * @returns {number} Returns the difference.
     * @example
     *
     * _.subtract(6, 4);
     * // => 2
     */
    var subtract = createMathOperation(function(minuend, subtrahend) {
      return minuend - subtrahend;
    }, 0);

    /**
     * Computes the sum of the values in `array`.
     *
     * @static
     * @memberOf _
     * @since 3.4.0
     * @category Math
     * @param {Array} array The array to iterate over.
     * @returns {number} Returns the sum.
     * @example
     *
     * _.sum([4, 2, 8, 6]);
     * // => 20
     */
    function sum(array) {
      return (array && array.length)
        ? baseSum(array, identity)
        : 0;
    }

    /**
     * This method is like `_.sum` except that it accepts `iteratee` which is
     * invoked for each element in `array` to generate the value to be summed.
     * The iteratee is invoked with one argument: (value).
     *
     * @static
     * @memberOf _
     * @since 4.0.0
     * @category Math
     * @param {Array} array The array to iterate over.
     * @param {Function} [iteratee=_.identity] The iteratee invoked per element.
     * @returns {number} Returns the sum.
     * @example
     *
     * var objects = [{ 'n': 4 }, { 'n': 2 }, { 'n': 8 }, { 'n': 6 }];
     *
     * _.sumBy(objects, function(o) { return o.n; });
     * // => 20
     *
     * // The `_.property` iteratee shorthand.
     * _.sumBy(objects, 'n');
     * // => 20
     */
    function sumBy(array, iteratee) {
      return (array && array.length)
        ? baseSum(array, getIteratee(iteratee, 2))
        : 0;
    }

    /*------------------------------------------------------------------------*/

    // Add methods that return wrapped values in chain sequences.
    lodash.after = after;
    lodash.ary = ary;
    lodash.assign = assign;
    lodash.assignIn = assignIn;
    lodash.assignInWith = assignInWith;
    lodash.assignWith = assignWith;
    lodash.at = at;
    lodash.before = before;
    lodash.bind = bind;
    lodash.bindAll = bindAll;
    lodash.bindKey = bindKey;
    lodash.castArray = castArray;
    lodash.chain = chain;
    lodash.chunk = chunk;
    lodash.compact = compact;
    lodash.concat = concat;
    lodash.cond = cond;
    lodash.conforms = conforms;
    lodash.constant = constant;
    lodash.countBy = countBy;
    lodash.create = create;
    lodash.curry = curry;
    lodash.curryRight = curryRight;
    lodash.debounce = debounce;
    lodash.defaults = defaults;
    lodash.defaultsDeep = defaultsDeep;
    lodash.defer = defer;
    lodash.delay = delay;
    lodash.difference = difference;
    lodash.differenceBy = differenceBy;
    lodash.differenceWith = differenceWith;
    lodash.drop = drop;
    lodash.dropRight = dropRight;
    lodash.dropRightWhile = dropRightWhile;
    lodash.dropWhile = dropWhile;
    lodash.fill = fill;
    lodash.filter = filter;
    lodash.flatMap = flatMap;
    lodash.flatMapDeep = flatMapDeep;
    lodash.flatMapDepth = flatMapDepth;
    lodash.flatten = flatten;
    lodash.flattenDeep = flattenDeep;
    lodash.flattenDepth = flattenDepth;
    lodash.flip = flip;
    lodash.flow = flow;
    lodash.flowRight = flowRight;
    lodash.fromPairs = fromPairs;
    lodash.functions = functions;
    lodash.functionsIn = functionsIn;
    lodash.groupBy = groupBy;
    lodash.initial = initial;
    lodash.intersection = intersection;
    lodash.intersectionBy = intersectionBy;
    lodash.intersectionWith = intersectionWith;
    lodash.invert = invert;
    lodash.invertBy = invertBy;
    lodash.invokeMap = invokeMap;
    lodash.iteratee = iteratee;
    lodash.keyBy = keyBy;
    lodash.keys = keys;
    lodash.keysIn = keysIn;
    lodash.map = map;
    lodash.mapKeys = mapKeys;
    lodash.mapValues = mapValues;
    lodash.matches = matches;
    lodash.matchesProperty = matchesProperty;
    lodash.memoize = memoize;
    lodash.merge = merge;
    lodash.mergeWith = mergeWith;
    lodash.method = method;
    lodash.methodOf = methodOf;
    lodash.mixin = mixin;
    lodash.negate = negate;
    lodash.nthArg = nthArg;
    lodash.omit = omit;
    lodash.omitBy = omitBy;
    lodash.once = once;
    lodash.orderBy = orderBy;
    lodash.over = over;
    lodash.overArgs = overArgs;
    lodash.overEvery = overEvery;
    lodash.overSome = overSome;
    lodash.partial = partial;
    lodash.partialRight = partialRight;
    lodash.partition = partition;
    lodash.pick = pick;
    lodash.pickBy = pickBy;
    lodash.property = property;
    lodash.propertyOf = propertyOf;
    lodash.pull = pull;
    lodash.pullAll = pullAll;
    lodash.pullAllBy = pullAllBy;
    lodash.pullAllWith = pullAllWith;
    lodash.pullAt = pullAt;
    lodash.range = range;
    lodash.rangeRight = rangeRight;
    lodash.rearg = rearg;
    lodash.reject = reject;
    lodash.remove = remove;
    lodash.rest = rest;
    lodash.reverse = reverse;
    lodash.sampleSize = sampleSize;
    lodash.set = set;
    lodash.setWith = setWith;
    lodash.shuffle = shuffle;
    lodash.slice = slice;
    lodash.sortBy = sortBy;
    lodash.sortedUniq = sortedUniq;
    lodash.sortedUniqBy = sortedUniqBy;
    lodash.split = split;
    lodash.spread = spread;
    lodash.tail = tail;
    lodash.take = take;
    lodash.takeRight = takeRight;
    lodash.takeRightWhile = takeRightWhile;
    lodash.takeWhile = takeWhile;
    lodash.tap = tap;
    lodash.throttle = throttle;
    lodash.thru = thru;
    lodash.toArray = toArray;
    lodash.toPairs = toPairs;
    lodash.toPairsIn = toPairsIn;
    lodash.toPath = toPath;
    lodash.toPlainObject = toPlainObject;
    lodash.transform = transform;
    lodash.unary = unary;
    lodash.union = union;
    lodash.unionBy = unionBy;
    lodash.unionWith = unionWith;
    lodash.uniq = uniq;
    lodash.uniqBy = uniqBy;
    lodash.uniqWith = uniqWith;
    lodash.unset = unset;
    lodash.unzip = unzip;
    lodash.unzipWith = unzipWith;
    lodash.update = update;
    lodash.updateWith = updateWith;
    lodash.values = values;
    lodash.valuesIn = valuesIn;
    lodash.without = without;
    lodash.words = words;
    lodash.wrap = wrap;
    lodash.xor = xor;
    lodash.xorBy = xorBy;
    lodash.xorWith = xorWith;
    lodash.zip = zip;
    lodash.zipObject = zipObject;
    lodash.zipObjectDeep = zipObjectDeep;
    lodash.zipWith = zipWith;

    // Add aliases.
    lodash.entries = toPairs;
    lodash.entriesIn = toPairsIn;
    lodash.extend = assignIn;
    lodash.extendWith = assignInWith;

    // Add methods to `lodash.prototype`.
    mixin(lodash, lodash);

    /*------------------------------------------------------------------------*/

    // Add methods that return unwrapped values in chain sequences.
    lodash.add = add;
    lodash.attempt = attempt;
    lodash.camelCase = camelCase;
    lodash.capitalize = capitalize;
    lodash.ceil = ceil;
    lodash.clamp = clamp;
    lodash.clone = clone;
    lodash.cloneDeep = cloneDeep;
    lodash.cloneDeepWith = cloneDeepWith;
    lodash.cloneWith = cloneWith;
    lodash.conformsTo = conformsTo;
    lodash.deburr = deburr;
    lodash.defaultTo = defaultTo;
    lodash.divide = divide;
    lodash.endsWith = endsWith;
    lodash.eq = eq;
    lodash.escape = escape;
    lodash.escapeRegExp = escapeRegExp;
    lodash.every = every;
    lodash.find = find;
    lodash.findIndex = findIndex;
    lodash.findKey = findKey;
    lodash.findLast = findLast;
    lodash.findLastIndex = findLastIndex;
    lodash.findLastKey = findLastKey;
    lodash.floor = floor;
    lodash.forEach = forEach;
    lodash.forEachRight = forEachRight;
    lodash.forIn = forIn;
    lodash.forInRight = forInRight;
    lodash.forOwn = forOwn;
    lodash.forOwnRight = forOwnRight;
    lodash.get = get;
    lodash.gt = gt;
    lodash.gte = gte;
    lodash.has = has;
    lodash.hasIn = hasIn;
    lodash.head = head;
    lodash.identity = identity;
    lodash.includes = includes;
    lodash.indexOf = indexOf;
    lodash.inRange = inRange;
    lodash.invoke = invoke;
    lodash.isArguments = isArguments;
    lodash.isArray = isArray;
    lodash.isArrayBuffer = isArrayBuffer;
    lodash.isArrayLike = isArrayLike;
    lodash.isArrayLikeObject = isArrayLikeObject;
    lodash.isBoolean = isBoolean;
    lodash.isBuffer = isBuffer;
    lodash.isDate = isDate;
    lodash.isElement = isElement;
    lodash.isEmpty = isEmpty;
    lodash.isEqual = isEqual;
    lodash.isEqualWith = isEqualWith;
    lodash.isError = isError;
    lodash.isFinite = isFinite;
    lodash.isFunction = isFunction;
    lodash.isInteger = isInteger;
    lodash.isLength = isLength;
    lodash.isMap = isMap;
    lodash.isMatch = isMatch;
    lodash.isMatchWith = isMatchWith;
    lodash.isNaN = isNaN;
    lodash.isNative = isNative;
    lodash.isNil = isNil;
    lodash.isNull = isNull;
    lodash.isNumber = isNumber;
    lodash.isObject = isObject;
    lodash.isObjectLike = isObjectLike;
    lodash.isPlainObject = isPlainObject;
    lodash.isRegExp = isRegExp;
    lodash.isSafeInteger = isSafeInteger;
    lodash.isSet = isSet;
    lodash.isString = isString;
    lodash.isSymbol = isSymbol;
    lodash.isTypedArray = isTypedArray;
    lodash.isUndefined = isUndefined;
    lodash.isWeakMap = isWeakMap;
    lodash.isWeakSet = isWeakSet;
    lodash.join = join;
    lodash.kebabCase = kebabCase;
    lodash.last = last;
    lodash.lastIndexOf = lastIndexOf;
    lodash.lowerCase = lowerCase;
    lodash.lowerFirst = lowerFirst;
    lodash.lt = lt;
    lodash.lte = lte;
    lodash.max = max;
    lodash.maxBy = maxBy;
    lodash.mean = mean;
    lodash.meanBy = meanBy;
    lodash.min = min;
    lodash.minBy = minBy;
    lodash.stubArray = stubArray;
    lodash.stubFalse = stubFalse;
    lodash.stubObject = stubObject;
    lodash.stubString = stubString;
    lodash.stubTrue = stubTrue;
    lodash.multiply = multiply;
    lodash.nth = nth;
    lodash.noConflict = noConflict;
    lodash.noop = noop;
    lodash.now = now;
    lodash.pad = pad;
    lodash.padEnd = padEnd;
    lodash.padStart = padStart;
    lodash.parseInt = parseInt;
    lodash.random = random;
    lodash.reduce = reduce;
    lodash.reduceRight = reduceRight;
    lodash.repeat = repeat;
    lodash.replace = replace;
    lodash.result = result;
    lodash.round = round;
    lodash.runInContext = runInContext;
    lodash.sample = sample;
    lodash.size = size;
    lodash.snakeCase = snakeCase;
    lodash.some = some;
    lodash.sortedIndex = sortedIndex;
    lodash.sortedIndexBy = sortedIndexBy;
    lodash.sortedIndexOf = sortedIndexOf;
    lodash.sortedLastIndex = sortedLastIndex;
    lodash.sortedLastIndexBy = sortedLastIndexBy;
    lodash.sortedLastIndexOf = sortedLastIndexOf;
    lodash.startCase = startCase;
    lodash.startsWith = startsWith;
    lodash.subtract = subtract;
    lodash.sum = sum;
    lodash.sumBy = sumBy;
    lodash.template = template;
    lodash.times = times;
    lodash.toFinite = toFinite;
    lodash.toInteger = toInteger;
    lodash.toLength = toLength;
    lodash.toLower = toLower;
    lodash.toNumber = toNumber;
    lodash.toSafeInteger = toSafeInteger;
    lodash.toString = toString;
    lodash.toUpper = toUpper;
    lodash.trim = trim;
    lodash.trimEnd = trimEnd;
    lodash.trimStart = trimStart;
    lodash.truncate = truncate;
    lodash.unescape = unescape;
    lodash.uniqueId = uniqueId;
    lodash.upperCase = upperCase;
    lodash.upperFirst = upperFirst;

    // Add aliases.
    lodash.each = forEach;
    lodash.eachRight = forEachRight;
    lodash.first = head;

    mixin(lodash, (function() {
      var source = {};
      baseForOwn(lodash, function(func, methodName) {
        if (!hasOwnProperty.call(lodash.prototype, methodName)) {
          source[methodName] = func;
        }
      });
      return source;
    }()), { 'chain': false });

    /*------------------------------------------------------------------------*/

    /**
     * The semantic version number.
     *
     * @static
     * @memberOf _
     * @type {string}
     */
    lodash.VERSION = VERSION;

    // Assign default placeholders.
    arrayEach(['bind', 'bindKey', 'curry', 'curryRight', 'partial', 'partialRight'], function(methodName) {
      lodash[methodName].placeholder = lodash;
    });

    // Add `LazyWrapper` methods for `_.drop` and `_.take` variants.
    arrayEach(['drop', 'take'], function(methodName, index) {
      LazyWrapper.prototype[methodName] = function(n) {
        n = n === undefined ? 1 : nativeMax(toInteger(n), 0);

        var result = (this.__filtered__ && !index)
          ? new LazyWrapper(this)
          : this.clone();

        if (result.__filtered__) {
          result.__takeCount__ = nativeMin(n, result.__takeCount__);
        } else {
          result.__views__.push({
            'size': nativeMin(n, MAX_ARRAY_LENGTH),
            'type': methodName + (result.__dir__ < 0 ? 'Right' : '')
          });
        }
        return result;
      };

      LazyWrapper.prototype[methodName + 'Right'] = function(n) {
        return this.reverse()[methodName](n).reverse();
      };
    });

    // Add `LazyWrapper` methods that accept an `iteratee` value.
    arrayEach(['filter', 'map', 'takeWhile'], function(methodName, index) {
      var type = index + 1,
          isFilter = type == LAZY_FILTER_FLAG || type == LAZY_WHILE_FLAG;

      LazyWrapper.prototype[methodName] = function(iteratee) {
        var result = this.clone();
        result.__iteratees__.push({
          'iteratee': getIteratee(iteratee, 3),
          'type': type
        });
        result.__filtered__ = result.__filtered__ || isFilter;
        return result;
      };
    });

    // Add `LazyWrapper` methods for `_.head` and `_.last`.
    arrayEach(['head', 'last'], function(methodName, index) {
      var takeName = 'take' + (index ? 'Right' : '');

      LazyWrapper.prototype[methodName] = function() {
        return this[takeName](1).value()[0];
      };
    });

    // Add `LazyWrapper` methods for `_.initial` and `_.tail`.
    arrayEach(['initial', 'tail'], function(methodName, index) {
      var dropName = 'drop' + (index ? '' : 'Right');

      LazyWrapper.prototype[methodName] = function() {
        return this.__filtered__ ? new LazyWrapper(this) : this[dropName](1);
      };
    });

    LazyWrapper.prototype.compact = function() {
      return this.filter(identity);
    };

    LazyWrapper.prototype.find = function(predicate) {
      return this.filter(predicate).head();
    };

    LazyWrapper.prototype.findLast = function(predicate) {
      return this.reverse().find(predicate);
    };

    LazyWrapper.prototype.invokeMap = baseRest(function(path, args) {
      if (typeof path == 'function') {
        return new LazyWrapper(this);
      }
      return this.map(function(value) {
        return baseInvoke(value, path, args);
      });
    });

    LazyWrapper.prototype.reject = function(predicate) {
      return this.filter(negate(getIteratee(predicate)));
    };

    LazyWrapper.prototype.slice = function(start, end) {
      start = toInteger(start);

      var result = this;
      if (result.__filtered__ && (start > 0 || end < 0)) {
        return new LazyWrapper(result);
      }
      if (start < 0) {
        result = result.takeRight(-start);
      } else if (start) {
        result = result.drop(start);
      }
      if (end !== undefined) {
        end = toInteger(end);
        result = end < 0 ? result.dropRight(-end) : result.take(end - start);
      }
      return result;
    };

    LazyWrapper.prototype.takeRightWhile = function(predicate) {
      return this.reverse().takeWhile(predicate).reverse();
    };

    LazyWrapper.prototype.toArray = function() {
      return this.take(MAX_ARRAY_LENGTH);
    };

    // Add `LazyWrapper` methods to `lodash.prototype`.
    baseForOwn(LazyWrapper.prototype, function(func, methodName) {
      var checkIteratee = /^(?:filter|find|map|reject)|While$/.test(methodName),
          isTaker = /^(?:head|last)$/.test(methodName),
          lodashFunc = lodash[isTaker ? ('take' + (methodName == 'last' ? 'Right' : '')) : methodName],
          retUnwrapped = isTaker || /^find/.test(methodName);

      if (!lodashFunc) {
        return;
      }
      lodash.prototype[methodName] = function() {
        var value = this.__wrapped__,
            args = isTaker ? [1] : arguments,
            isLazy = value instanceof LazyWrapper,
            iteratee = args[0],
            useLazy = isLazy || isArray(value);

        var interceptor = function(value) {
          var result = lodashFunc.apply(lodash, arrayPush([value], args));
          return (isTaker && chainAll) ? result[0] : result;
        };

        if (useLazy && checkIteratee && typeof iteratee == 'function' && iteratee.length != 1) {
          // Avoid lazy use if the iteratee has a "length" value other than `1`.
          isLazy = useLazy = false;
        }
        var chainAll = this.__chain__,
            isHybrid = !!this.__actions__.length,
            isUnwrapped = retUnwrapped && !chainAll,
            onlyLazy = isLazy && !isHybrid;

        if (!retUnwrapped && useLazy) {
          value = onlyLazy ? value : new LazyWrapper(this);
          var result = func.apply(value, args);
          result.__actions__.push({ 'func': thru, 'args': [interceptor], 'thisArg': undefined });
          return new LodashWrapper(result, chainAll);
        }
        if (isUnwrapped && onlyLazy) {
          return func.apply(this, args);
        }
        result = this.thru(interceptor);
        return isUnwrapped ? (isTaker ? result.value()[0] : result.value()) : result;
      };
    });

    // Add `Array` methods to `lodash.prototype`.
    arrayEach(['pop', 'push', 'shift', 'sort', 'splice', 'unshift'], function(methodName) {
      var func = arrayProto[methodName],
          chainName = /^(?:push|sort|unshift)$/.test(methodName) ? 'tap' : 'thru',
          retUnwrapped = /^(?:pop|shift)$/.test(methodName);

      lodash.prototype[methodName] = function() {
        var args = arguments;
        if (retUnwrapped && !this.__chain__) {
          var value = this.value();
          return func.apply(isArray(value) ? value : [], args);
        }
        return this[chainName](function(value) {
          return func.apply(isArray(value) ? value : [], args);
        });
      };
    });

    // Map minified method names to their real names.
    baseForOwn(LazyWrapper.prototype, function(func, methodName) {
      var lodashFunc = lodash[methodName];
      if (lodashFunc) {
        var key = (lodashFunc.name + ''),
            names = realNames[key] || (realNames[key] = []);

        names.push({ 'name': methodName, 'func': lodashFunc });
      }
    });

    realNames[createHybrid(undefined, WRAP_BIND_KEY_FLAG).name] = [{
      'name': 'wrapper',
      'func': undefined
    }];

    // Add methods to `LazyWrapper`.
    LazyWrapper.prototype.clone = lazyClone;
    LazyWrapper.prototype.reverse = lazyReverse;
    LazyWrapper.prototype.value = lazyValue;

    // Add chain sequence methods to the `lodash` wrapper.
    lodash.prototype.at = wrapperAt;
    lodash.prototype.chain = wrapperChain;
    lodash.prototype.commit = wrapperCommit;
    lodash.prototype.next = wrapperNext;
    lodash.prototype.plant = wrapperPlant;
    lodash.prototype.reverse = wrapperReverse;
    lodash.prototype.toJSON = lodash.prototype.valueOf = lodash.prototype.value = wrapperValue;

    // Add lazy aliases.
    lodash.prototype.first = lodash.prototype.head;

    if (symIterator) {
      lodash.prototype[symIterator] = wrapperToIterator;
    }
    return lodash;
  });

  /*--------------------------------------------------------------------------*/

  // Export lodash.
  var _ = runInContext();

  // Some AMD build optimizers, like r.js, check for condition patterns like:
  if (typeof define == 'function' && typeof define.amd == 'object' && define.amd) {
    // Expose Lodash on the global object to prevent errors when Lodash is
    // loaded by a script tag in the presence of an AMD loader.
    // See http://requirejs.org/docs/errors.html#mismatch for more details.
    // Use `_.noConflict` to remove Lodash from the global object.
    root._ = _;

    // Define as an anonymous module so, through path mapping, it can be
    // referenced as the "underscore" module.
    define(function() {
      return _;
    });
  }
  // Check for `exports` after `define` in case a build optimizer adds it.
  else if (freeModule) {
    // Export for Node.js.
    (freeModule.exports = _)._ = _;
    // Export for CommonJS support.
    freeExports._ = _;
  }
  else {
    // Export to the global object.
    root._ = _;
  }
}.call(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})

},{}],3:[function(require,module,exports){
'use strict'

module.exports = monotoneConvexHull2D

var orient = require('robust-orientation')[3]

function monotoneConvexHull2D(points) {
  var n = points.length

  if(n < 3) {
    var result = new Array(n)
    for(var i=0; i<n; ++i) {
      result[i] = i
    }

    if(n === 2 &&
       points[0][0] === points[1][0] &&
       points[0][1] === points[1][1]) {
      return [0]
    }

    return result
  }

  //Sort point indices along x-axis
  var sorted = new Array(n)
  for(var i=0; i<n; ++i) {
    sorted[i] = i
  }
  sorted.sort(function(a,b) {
    var d = points[a][0]-points[b][0]
    if(d) {
      return d
    }
    return points[a][1] - points[b][1]
  })

  //Construct upper and lower hulls
  var lower = [sorted[0], sorted[1]]
  var upper = [sorted[0], sorted[1]]

  for(var i=2; i<n; ++i) {
    var idx = sorted[i]
    var p   = points[idx]

    //Insert into lower list
    var m = lower.length
    while(m > 1 && orient(
        points[lower[m-2]], 
        points[lower[m-1]], 
        p) <= 0) {
      m -= 1
      lower.pop()
    }
    lower.push(idx)

    //Insert into upper list
    m = upper.length
    while(m > 1 && orient(
        points[upper[m-2]], 
        points[upper[m-1]], 
        p) >= 0) {
      m -= 1
      upper.pop()
    }
    upper.push(idx)
  }

  //Merge lists together
  var result = new Array(upper.length + lower.length - 2)
  var ptr    = 0
  for(var i=0, nl=lower.length; i<nl; ++i) {
    result[ptr++] = lower[i]
  }
  for(var j=upper.length-2; j>0; --j) {
    result[ptr++] = upper[j]
  }

  //Return result
  return result
}
},{"robust-orientation":7}],4:[function(require,module,exports){
module.exports = function (point, vs) {
    // ray-casting algorithm based on
    // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html
    
    var x = point[0], y = point[1];
    
    var inside = false;
    for (var i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        var xi = vs[i][0], yi = vs[i][1];
        var xj = vs[j][0], yj = vs[j][1];
        
        var intersect = ((yi > y) != (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    
    return inside;
};

},{}],5:[function(require,module,exports){
'use strict';

module.exports = partialSort;

// Floyd-Rivest selection algorithm:
// Rearrange items so that all items in the [left, k] range are smaller than all items in (k, right];
// The k-th element will have the (k - left + 1)th smallest value in [left, right]

function partialSort(arr, k, left, right, compare) {
    left = left || 0;
    right = right || (arr.length - 1);
    compare = compare || defaultCompare;

    while (right > left) {
        if (right - left > 600) {
            var n = right - left + 1;
            var m = k - left + 1;
            var z = Math.log(n);
            var s = 0.5 * Math.exp(2 * z / 3);
            var sd = 0.5 * Math.sqrt(z * s * (n - s) / n) * (m - n / 2 < 0 ? -1 : 1);
            var newLeft = Math.max(left, Math.floor(k - m * s / n + sd));
            var newRight = Math.min(right, Math.floor(k + (n - m) * s / n + sd));
            partialSort(arr, k, newLeft, newRight, compare);
        }

        var t = arr[k];
        var i = left;
        var j = right;

        swap(arr, left, k);
        if (compare(arr[right], t) > 0) swap(arr, left, right);

        while (i < j) {
            swap(arr, i, j);
            i++;
            j--;
            while (compare(arr[i], t) < 0) i++;
            while (compare(arr[j], t) > 0) j--;
        }

        if (compare(arr[left], t) === 0) swap(arr, left, j);
        else {
            j++;
            swap(arr, j, right);
        }

        if (j <= k) left = j + 1;
        if (k <= j) right = j - 1;
    }
}

function swap(arr, i, j) {
    var tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
}

function defaultCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

},{}],6:[function(require,module,exports){
'use strict';

module.exports = rbush;

var quickselect = require('quickselect');

function rbush(maxEntries, format) {
    if (!(this instanceof rbush)) return new rbush(maxEntries, format);

    // max entries in a node is 9 by default; min node fill is 40% for best performance
    this._maxEntries = Math.max(4, maxEntries || 9);
    this._minEntries = Math.max(2, Math.ceil(this._maxEntries * 0.4));

    if (format) {
        this._initFormat(format);
    }

    this.clear();
}

rbush.prototype = {

    all: function () {
        return this._all(this.data, []);
    },

    search: function (bbox) {

        var node = this.data,
            result = [],
            toBBox = this.toBBox;

        if (!intersects(bbox, node)) return result;

        var nodesToSearch = [],
            i, len, child, childBBox;

        while (node) {
            for (i = 0, len = node.children.length; i < len; i++) {

                child = node.children[i];
                childBBox = node.leaf ? toBBox(child) : child;

                if (intersects(bbox, childBBox)) {
                    if (node.leaf) result.push(child);
                    else if (contains(bbox, childBBox)) this._all(child, result);
                    else nodesToSearch.push(child);
                }
            }
            node = nodesToSearch.pop();
        }

        return result;
    },

    collides: function (bbox) {

        var node = this.data,
            toBBox = this.toBBox;

        if (!intersects(bbox, node)) return false;

        var nodesToSearch = [],
            i, len, child, childBBox;

        while (node) {
            for (i = 0, len = node.children.length; i < len; i++) {

                child = node.children[i];
                childBBox = node.leaf ? toBBox(child) : child;

                if (intersects(bbox, childBBox)) {
                    if (node.leaf || contains(bbox, childBBox)) return true;
                    nodesToSearch.push(child);
                }
            }
            node = nodesToSearch.pop();
        }

        return false;
    },

    load: function (data) {
        if (!(data && data.length)) return this;

        if (data.length < this._minEntries) {
            for (var i = 0, len = data.length; i < len; i++) {
                this.insert(data[i]);
            }
            return this;
        }

        // recursively build the tree with the given data from stratch using OMT algorithm
        var node = this._build(data.slice(), 0, data.length - 1, 0);

        if (!this.data.children.length) {
            // save as is if tree is empty
            this.data = node;

        } else if (this.data.height === node.height) {
            // split root if trees have the same height
            this._splitRoot(this.data, node);

        } else {
            if (this.data.height < node.height) {
                // swap trees if inserted one is bigger
                var tmpNode = this.data;
                this.data = node;
                node = tmpNode;
            }

            // insert the small tree into the large tree at appropriate level
            this._insert(node, this.data.height - node.height - 1, true);
        }

        return this;
    },

    insert: function (item) {
        if (item) this._insert(item, this.data.height - 1);
        return this;
    },

    clear: function () {
        this.data = createNode([]);
        return this;
    },

    remove: function (item, equalsFn) {
        if (!item) return this;

        var node = this.data,
            bbox = this.toBBox(item),
            path = [],
            indexes = [],
            i, parent, index, goingUp;

        // depth-first iterative tree traversal
        while (node || path.length) {

            if (!node) { // go up
                node = path.pop();
                parent = path[path.length - 1];
                i = indexes.pop();
                goingUp = true;
            }

            if (node.leaf) { // check current node
                index = findItem(item, node.children, equalsFn);

                if (index !== -1) {
                    // item found, remove the item and condense tree upwards
                    node.children.splice(index, 1);
                    path.push(node);
                    this._condense(path);
                    return this;
                }
            }

            if (!goingUp && !node.leaf && contains(node, bbox)) { // go down
                path.push(node);
                indexes.push(i);
                i = 0;
                parent = node;
                node = node.children[0];

            } else if (parent) { // go right
                i++;
                node = parent.children[i];
                goingUp = false;

            } else node = null; // nothing found
        }

        return this;
    },

    toBBox: function (item) { return item; },

    compareMinX: compareNodeMinX,
    compareMinY: compareNodeMinY,

    toJSON: function () { return this.data; },

    fromJSON: function (data) {
        this.data = data;
        return this;
    },

    _all: function (node, result) {
        var nodesToSearch = [];
        while (node) {
            if (node.leaf) result.push.apply(result, node.children);
            else nodesToSearch.push.apply(nodesToSearch, node.children);

            node = nodesToSearch.pop();
        }
        return result;
    },

    _build: function (items, left, right, height) {

        var N = right - left + 1,
            M = this._maxEntries,
            node;

        if (N <= M) {
            // reached leaf level; return leaf
            node = createNode(items.slice(left, right + 1));
            calcBBox(node, this.toBBox);
            return node;
        }

        if (!height) {
            // target height of the bulk-loaded tree
            height = Math.ceil(Math.log(N) / Math.log(M));

            // target number of root entries to maximize storage utilization
            M = Math.ceil(N / Math.pow(M, height - 1));
        }

        node = createNode([]);
        node.leaf = false;
        node.height = height;

        // split the items into M mostly square tiles

        var N2 = Math.ceil(N / M),
            N1 = N2 * Math.ceil(Math.sqrt(M)),
            i, j, right2, right3;

        multiSelect(items, left, right, N1, this.compareMinX);

        for (i = left; i <= right; i += N1) {

            right2 = Math.min(i + N1 - 1, right);

            multiSelect(items, i, right2, N2, this.compareMinY);

            for (j = i; j <= right2; j += N2) {

                right3 = Math.min(j + N2 - 1, right2);

                // pack each entry recursively
                node.children.push(this._build(items, j, right3, height - 1));
            }
        }

        calcBBox(node, this.toBBox);

        return node;
    },

    _chooseSubtree: function (bbox, node, level, path) {

        var i, len, child, targetNode, area, enlargement, minArea, minEnlargement;

        while (true) {
            path.push(node);

            if (node.leaf || path.length - 1 === level) break;

            minArea = minEnlargement = Infinity;

            for (i = 0, len = node.children.length; i < len; i++) {
                child = node.children[i];
                area = bboxArea(child);
                enlargement = enlargedArea(bbox, child) - area;

                // choose entry with the least area enlargement
                if (enlargement < minEnlargement) {
                    minEnlargement = enlargement;
                    minArea = area < minArea ? area : minArea;
                    targetNode = child;

                } else if (enlargement === minEnlargement) {
                    // otherwise choose one with the smallest area
                    if (area < minArea) {
                        minArea = area;
                        targetNode = child;
                    }
                }
            }

            node = targetNode || node.children[0];
        }

        return node;
    },

    _insert: function (item, level, isNode) {

        var toBBox = this.toBBox,
            bbox = isNode ? item : toBBox(item),
            insertPath = [];

        // find the best node for accommodating the item, saving all nodes along the path too
        var node = this._chooseSubtree(bbox, this.data, level, insertPath);

        // put the item into the node
        node.children.push(item);
        extend(node, bbox);

        // split on node overflow; propagate upwards if necessary
        while (level >= 0) {
            if (insertPath[level].children.length > this._maxEntries) {
                this._split(insertPath, level);
                level--;
            } else break;
        }

        // adjust bboxes along the insertion path
        this._adjustParentBBoxes(bbox, insertPath, level);
    },

    // split overflowed node into two
    _split: function (insertPath, level) {

        var node = insertPath[level],
            M = node.children.length,
            m = this._minEntries;

        this._chooseSplitAxis(node, m, M);

        var splitIndex = this._chooseSplitIndex(node, m, M);

        var newNode = createNode(node.children.splice(splitIndex, node.children.length - splitIndex));
        newNode.height = node.height;
        newNode.leaf = node.leaf;

        calcBBox(node, this.toBBox);
        calcBBox(newNode, this.toBBox);

        if (level) insertPath[level - 1].children.push(newNode);
        else this._splitRoot(node, newNode);
    },

    _splitRoot: function (node, newNode) {
        // split root node
        this.data = createNode([node, newNode]);
        this.data.height = node.height + 1;
        this.data.leaf = false;
        calcBBox(this.data, this.toBBox);
    },

    _chooseSplitIndex: function (node, m, M) {

        var i, bbox1, bbox2, overlap, area, minOverlap, minArea, index;

        minOverlap = minArea = Infinity;

        for (i = m; i <= M - m; i++) {
            bbox1 = distBBox(node, 0, i, this.toBBox);
            bbox2 = distBBox(node, i, M, this.toBBox);

            overlap = intersectionArea(bbox1, bbox2);
            area = bboxArea(bbox1) + bboxArea(bbox2);

            // choose distribution with minimum overlap
            if (overlap < minOverlap) {
                minOverlap = overlap;
                index = i;

                minArea = area < minArea ? area : minArea;

            } else if (overlap === minOverlap) {
                // otherwise choose distribution with minimum area
                if (area < minArea) {
                    minArea = area;
                    index = i;
                }
            }
        }

        return index;
    },

    // sorts node children by the best axis for split
    _chooseSplitAxis: function (node, m, M) {

        var compareMinX = node.leaf ? this.compareMinX : compareNodeMinX,
            compareMinY = node.leaf ? this.compareMinY : compareNodeMinY,
            xMargin = this._allDistMargin(node, m, M, compareMinX),
            yMargin = this._allDistMargin(node, m, M, compareMinY);

        // if total distributions margin value is minimal for x, sort by minX,
        // otherwise it's already sorted by minY
        if (xMargin < yMargin) node.children.sort(compareMinX);
    },

    // total margin of all possible split distributions where each node is at least m full
    _allDistMargin: function (node, m, M, compare) {

        node.children.sort(compare);

        var toBBox = this.toBBox,
            leftBBox = distBBox(node, 0, m, toBBox),
            rightBBox = distBBox(node, M - m, M, toBBox),
            margin = bboxMargin(leftBBox) + bboxMargin(rightBBox),
            i, child;

        for (i = m; i < M - m; i++) {
            child = node.children[i];
            extend(leftBBox, node.leaf ? toBBox(child) : child);
            margin += bboxMargin(leftBBox);
        }

        for (i = M - m - 1; i >= m; i--) {
            child = node.children[i];
            extend(rightBBox, node.leaf ? toBBox(child) : child);
            margin += bboxMargin(rightBBox);
        }

        return margin;
    },

    _adjustParentBBoxes: function (bbox, path, level) {
        // adjust bboxes along the given tree path
        for (var i = level; i >= 0; i--) {
            extend(path[i], bbox);
        }
    },

    _condense: function (path) {
        // go through the path, removing empty nodes and updating bboxes
        for (var i = path.length - 1, siblings; i >= 0; i--) {
            if (path[i].children.length === 0) {
                if (i > 0) {
                    siblings = path[i - 1].children;
                    siblings.splice(siblings.indexOf(path[i]), 1);

                } else this.clear();

            } else calcBBox(path[i], this.toBBox);
        }
    },

    _initFormat: function (format) {
        // data format (minX, minY, maxX, maxY accessors)

        // uses eval-type function compilation instead of just accepting a toBBox function
        // because the algorithms are very sensitive to sorting functions performance,
        // so they should be dead simple and without inner calls

        var compareArr = ['return a', ' - b', ';'];

        this.compareMinX = new Function('a', 'b', compareArr.join(format[0]));
        this.compareMinY = new Function('a', 'b', compareArr.join(format[1]));

        this.toBBox = new Function('a',
            'return {minX: a' + format[0] +
            ', minY: a' + format[1] +
            ', maxX: a' + format[2] +
            ', maxY: a' + format[3] + '};');
    }
};

function findItem(item, items, equalsFn) {
    if (!equalsFn) return items.indexOf(item);

    for (var i = 0; i < items.length; i++) {
        if (equalsFn(item, items[i])) return i;
    }
    return -1;
}

// calculate node's bbox from bboxes of its children
function calcBBox(node, toBBox) {
    distBBox(node, 0, node.children.length, toBBox, node);
}

// min bounding rectangle of node children from k to p-1
function distBBox(node, k, p, toBBox, destNode) {
    if (!destNode) destNode = createNode(null);
    destNode.minX = Infinity;
    destNode.minY = Infinity;
    destNode.maxX = -Infinity;
    destNode.maxY = -Infinity;

    for (var i = k, child; i < p; i++) {
        child = node.children[i];
        extend(destNode, node.leaf ? toBBox(child) : child);
    }

    return destNode;
}

function extend(a, b) {
    a.minX = Math.min(a.minX, b.minX);
    a.minY = Math.min(a.minY, b.minY);
    a.maxX = Math.max(a.maxX, b.maxX);
    a.maxY = Math.max(a.maxY, b.maxY);
    return a;
}

function compareNodeMinX(a, b) { return a.minX - b.minX; }
function compareNodeMinY(a, b) { return a.minY - b.minY; }

function bboxArea(a)   { return (a.maxX - a.minX) * (a.maxY - a.minY); }
function bboxMargin(a) { return (a.maxX - a.minX) + (a.maxY - a.minY); }

function enlargedArea(a, b) {
    return (Math.max(b.maxX, a.maxX) - Math.min(b.minX, a.minX)) *
           (Math.max(b.maxY, a.maxY) - Math.min(b.minY, a.minY));
}

function intersectionArea(a, b) {
    var minX = Math.max(a.minX, b.minX),
        minY = Math.max(a.minY, b.minY),
        maxX = Math.min(a.maxX, b.maxX),
        maxY = Math.min(a.maxY, b.maxY);

    return Math.max(0, maxX - minX) *
           Math.max(0, maxY - minY);
}

function contains(a, b) {
    return a.minX <= b.minX &&
           a.minY <= b.minY &&
           b.maxX <= a.maxX &&
           b.maxY <= a.maxY;
}

function intersects(a, b) {
    return b.minX <= a.maxX &&
           b.minY <= a.maxY &&
           b.maxX >= a.minX &&
           b.maxY >= a.minY;
}

function createNode(children) {
    return {
        children: children,
        height: 1,
        leaf: true,
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };
}

// sort an array so that items come in groups of n unsorted items, with groups sorted between each other;
// combines selection algorithm with binary divide & conquer approach

function multiSelect(arr, left, right, n, compare) {
    var stack = [left, right],
        mid;

    while (stack.length) {
        right = stack.pop();
        left = stack.pop();

        if (right - left <= n) continue;

        mid = left + Math.ceil((right - left) / n / 2) * n;
        quickselect(arr, mid, left, right, compare);

        stack.push(left, mid, mid, right);
    }
}

},{"quickselect":5}],7:[function(require,module,exports){
"use strict"

var twoProduct = require("two-product")
var robustSum = require("robust-sum")
var robustScale = require("robust-scale")
var robustSubtract = require("robust-subtract")

var NUM_EXPAND = 5

var EPSILON     = 1.1102230246251565e-16
var ERRBOUND3   = (3.0 + 16.0 * EPSILON) * EPSILON
var ERRBOUND4   = (7.0 + 56.0 * EPSILON) * EPSILON

function cofactor(m, c) {
  var result = new Array(m.length-1)
  for(var i=1; i<m.length; ++i) {
    var r = result[i-1] = new Array(m.length-1)
    for(var j=0,k=0; j<m.length; ++j) {
      if(j === c) {
        continue
      }
      r[k++] = m[i][j]
    }
  }
  return result
}

function matrix(n) {
  var result = new Array(n)
  for(var i=0; i<n; ++i) {
    result[i] = new Array(n)
    for(var j=0; j<n; ++j) {
      result[i][j] = ["m", j, "[", (n-i-1), "]"].join("")
    }
  }
  return result
}

function sign(n) {
  if(n & 1) {
    return "-"
  }
  return ""
}

function generateSum(expr) {
  if(expr.length === 1) {
    return expr[0]
  } else if(expr.length === 2) {
    return ["sum(", expr[0], ",", expr[1], ")"].join("")
  } else {
    var m = expr.length>>1
    return ["sum(", generateSum(expr.slice(0, m)), ",", generateSum(expr.slice(m)), ")"].join("")
  }
}

function determinant(m) {
  if(m.length === 2) {
    return [["sum(prod(", m[0][0], ",", m[1][1], "),prod(-", m[0][1], ",", m[1][0], "))"].join("")]
  } else {
    var expr = []
    for(var i=0; i<m.length; ++i) {
      expr.push(["scale(", generateSum(determinant(cofactor(m, i))), ",", sign(i), m[0][i], ")"].join(""))
    }
    return expr
  }
}

function orientation(n) {
  var pos = []
  var neg = []
  var m = matrix(n)
  var args = []
  for(var i=0; i<n; ++i) {
    if((i&1)===0) {
      pos.push.apply(pos, determinant(cofactor(m, i)))
    } else {
      neg.push.apply(neg, determinant(cofactor(m, i)))
    }
    args.push("m" + i)
  }
  var posExpr = generateSum(pos)
  var negExpr = generateSum(neg)
  var funcName = "orientation" + n + "Exact"
  var code = ["function ", funcName, "(", args.join(), "){var p=", posExpr, ",n=", negExpr, ",d=sub(p,n);\
return d[d.length-1];};return ", funcName].join("")
  var proc = new Function("sum", "prod", "scale", "sub", code)
  return proc(robustSum, twoProduct, robustScale, robustSubtract)
}

var orientation3Exact = orientation(3)
var orientation4Exact = orientation(4)

var CACHED = [
  function orientation0() { return 0 },
  function orientation1() { return 0 },
  function orientation2(a, b) { 
    return b[0] - a[0]
  },
  function orientation3(a, b, c) {
    var l = (a[1] - c[1]) * (b[0] - c[0])
    var r = (a[0] - c[0]) * (b[1] - c[1])
    var det = l - r
    var s
    if(l > 0) {
      if(r <= 0) {
        return det
      } else {
        s = l + r
      }
    } else if(l < 0) {
      if(r >= 0) {
        return det
      } else {
        s = -(l + r)
      }
    } else {
      return det
    }
    var tol = ERRBOUND3 * s
    if(det >= tol || det <= -tol) {
      return det
    }
    return orientation3Exact(a, b, c)
  },
  function orientation4(a,b,c,d) {
    var adx = a[0] - d[0]
    var bdx = b[0] - d[0]
    var cdx = c[0] - d[0]
    var ady = a[1] - d[1]
    var bdy = b[1] - d[1]
    var cdy = c[1] - d[1]
    var adz = a[2] - d[2]
    var bdz = b[2] - d[2]
    var cdz = c[2] - d[2]
    var bdxcdy = bdx * cdy
    var cdxbdy = cdx * bdy
    var cdxady = cdx * ady
    var adxcdy = adx * cdy
    var adxbdy = adx * bdy
    var bdxady = bdx * ady
    var det = adz * (bdxcdy - cdxbdy) 
            + bdz * (cdxady - adxcdy)
            + cdz * (adxbdy - bdxady)
    var permanent = (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * Math.abs(adz)
                  + (Math.abs(cdxady) + Math.abs(adxcdy)) * Math.abs(bdz)
                  + (Math.abs(adxbdy) + Math.abs(bdxady)) * Math.abs(cdz)
    var tol = ERRBOUND4 * permanent
    if ((det > tol) || (-det > tol)) {
      return det
    }
    return orientation4Exact(a,b,c,d)
  }
]

function slowOrient(args) {
  var proc = CACHED[args.length]
  if(!proc) {
    proc = CACHED[args.length] = orientation(args.length)
  }
  return proc.apply(undefined, args)
}

function generateOrientationProc() {
  while(CACHED.length <= NUM_EXPAND) {
    CACHED.push(orientation(CACHED.length))
  }
  var args = []
  var procArgs = ["slow"]
  for(var i=0; i<=NUM_EXPAND; ++i) {
    args.push("a" + i)
    procArgs.push("o" + i)
  }
  var code = [
    "function getOrientation(", args.join(), "){switch(arguments.length){case 0:case 1:return 0;"
  ]
  for(var i=2; i<=NUM_EXPAND; ++i) {
    code.push("case ", i, ":return o", i, "(", args.slice(0, i).join(), ");")
  }
  code.push("}var s=new Array(arguments.length);for(var i=0;i<arguments.length;++i){s[i]=arguments[i]};return slow(s);}return getOrientation")
  procArgs.push(code.join(""))

  var proc = Function.apply(undefined, procArgs)
  module.exports = proc.apply(undefined, [slowOrient].concat(CACHED))
  for(var i=0; i<=NUM_EXPAND; ++i) {
    module.exports[i] = CACHED[i]
  }
}

generateOrientationProc()
},{"robust-scale":8,"robust-subtract":9,"robust-sum":10,"two-product":13}],8:[function(require,module,exports){
"use strict"

var twoProduct = require("two-product")
var twoSum = require("two-sum")

module.exports = scaleLinearExpansion

function scaleLinearExpansion(e, scale) {
  var n = e.length
  if(n === 1) {
    var ts = twoProduct(e[0], scale)
    if(ts[0]) {
      return ts
    }
    return [ ts[1] ]
  }
  var g = new Array(2 * n)
  var q = [0.1, 0.1]
  var t = [0.1, 0.1]
  var count = 0
  twoProduct(e[0], scale, q)
  if(q[0]) {
    g[count++] = q[0]
  }
  for(var i=1; i<n; ++i) {
    twoProduct(e[i], scale, t)
    var pq = q[1]
    twoSum(pq, t[0], q)
    if(q[0]) {
      g[count++] = q[0]
    }
    var a = t[1]
    var b = q[1]
    var x = a + b
    var bv = x - a
    var y = b - bv
    q[1] = x
    if(y) {
      g[count++] = y
    }
  }
  if(q[1]) {
    g[count++] = q[1]
  }
  if(count === 0) {
    g[count++] = 0.0
  }
  g.length = count
  return g
}
},{"two-product":13,"two-sum":14}],9:[function(require,module,exports){
"use strict"

module.exports = robustSubtract

//Easy case: Add two scalars
function scalarScalar(a, b) {
  var x = a + b
  var bv = x - a
  var av = x - bv
  var br = b - bv
  var ar = a - av
  var y = ar + br
  if(y) {
    return [y, x]
  }
  return [x]
}

function robustSubtract(e, f) {
  var ne = e.length|0
  var nf = f.length|0
  if(ne === 1 && nf === 1) {
    return scalarScalar(e[0], -f[0])
  }
  var n = ne + nf
  var g = new Array(n)
  var count = 0
  var eptr = 0
  var fptr = 0
  var abs = Math.abs
  var ei = e[eptr]
  var ea = abs(ei)
  var fi = -f[fptr]
  var fa = abs(fi)
  var a, b
  if(ea < fa) {
    b = ei
    eptr += 1
    if(eptr < ne) {
      ei = e[eptr]
      ea = abs(ei)
    }
  } else {
    b = fi
    fptr += 1
    if(fptr < nf) {
      fi = -f[fptr]
      fa = abs(fi)
    }
  }
  if((eptr < ne && ea < fa) || (fptr >= nf)) {
    a = ei
    eptr += 1
    if(eptr < ne) {
      ei = e[eptr]
      ea = abs(ei)
    }
  } else {
    a = fi
    fptr += 1
    if(fptr < nf) {
      fi = -f[fptr]
      fa = abs(fi)
    }
  }
  var x = a + b
  var bv = x - a
  var y = b - bv
  var q0 = y
  var q1 = x
  var _x, _bv, _av, _br, _ar
  while(eptr < ne && fptr < nf) {
    if(ea < fa) {
      a = ei
      eptr += 1
      if(eptr < ne) {
        ei = e[eptr]
        ea = abs(ei)
      }
    } else {
      a = fi
      fptr += 1
      if(fptr < nf) {
        fi = -f[fptr]
        fa = abs(fi)
      }
    }
    b = q0
    x = a + b
    bv = x - a
    y = b - bv
    if(y) {
      g[count++] = y
    }
    _x = q1 + x
    _bv = _x - q1
    _av = _x - _bv
    _br = x - _bv
    _ar = q1 - _av
    q0 = _ar + _br
    q1 = _x
  }
  while(eptr < ne) {
    a = ei
    b = q0
    x = a + b
    bv = x - a
    y = b - bv
    if(y) {
      g[count++] = y
    }
    _x = q1 + x
    _bv = _x - q1
    _av = _x - _bv
    _br = x - _bv
    _ar = q1 - _av
    q0 = _ar + _br
    q1 = _x
    eptr += 1
    if(eptr < ne) {
      ei = e[eptr]
    }
  }
  while(fptr < nf) {
    a = fi
    b = q0
    x = a + b
    bv = x - a
    y = b - bv
    if(y) {
      g[count++] = y
    } 
    _x = q1 + x
    _bv = _x - q1
    _av = _x - _bv
    _br = x - _bv
    _ar = q1 - _av
    q0 = _ar + _br
    q1 = _x
    fptr += 1
    if(fptr < nf) {
      fi = -f[fptr]
    }
  }
  if(q0) {
    g[count++] = q0
  }
  if(q1) {
    g[count++] = q1
  }
  if(!count) {
    g[count++] = 0.0  
  }
  g.length = count
  return g
}
},{}],10:[function(require,module,exports){
"use strict"

module.exports = linearExpansionSum

//Easy case: Add two scalars
function scalarScalar(a, b) {
  var x = a + b
  var bv = x - a
  var av = x - bv
  var br = b - bv
  var ar = a - av
  var y = ar + br
  if(y) {
    return [y, x]
  }
  return [x]
}

function linearExpansionSum(e, f) {
  var ne = e.length|0
  var nf = f.length|0
  if(ne === 1 && nf === 1) {
    return scalarScalar(e[0], f[0])
  }
  var n = ne + nf
  var g = new Array(n)
  var count = 0
  var eptr = 0
  var fptr = 0
  var abs = Math.abs
  var ei = e[eptr]
  var ea = abs(ei)
  var fi = f[fptr]
  var fa = abs(fi)
  var a, b
  if(ea < fa) {
    b = ei
    eptr += 1
    if(eptr < ne) {
      ei = e[eptr]
      ea = abs(ei)
    }
  } else {
    b = fi
    fptr += 1
    if(fptr < nf) {
      fi = f[fptr]
      fa = abs(fi)
    }
  }
  if((eptr < ne && ea < fa) || (fptr >= nf)) {
    a = ei
    eptr += 1
    if(eptr < ne) {
      ei = e[eptr]
      ea = abs(ei)
    }
  } else {
    a = fi
    fptr += 1
    if(fptr < nf) {
      fi = f[fptr]
      fa = abs(fi)
    }
  }
  var x = a + b
  var bv = x - a
  var y = b - bv
  var q0 = y
  var q1 = x
  var _x, _bv, _av, _br, _ar
  while(eptr < ne && fptr < nf) {
    if(ea < fa) {
      a = ei
      eptr += 1
      if(eptr < ne) {
        ei = e[eptr]
        ea = abs(ei)
      }
    } else {
      a = fi
      fptr += 1
      if(fptr < nf) {
        fi = f[fptr]
        fa = abs(fi)
      }
    }
    b = q0
    x = a + b
    bv = x - a
    y = b - bv
    if(y) {
      g[count++] = y
    }
    _x = q1 + x
    _bv = _x - q1
    _av = _x - _bv
    _br = x - _bv
    _ar = q1 - _av
    q0 = _ar + _br
    q1 = _x
  }
  while(eptr < ne) {
    a = ei
    b = q0
    x = a + b
    bv = x - a
    y = b - bv
    if(y) {
      g[count++] = y
    }
    _x = q1 + x
    _bv = _x - q1
    _av = _x - _bv
    _br = x - _bv
    _ar = q1 - _av
    q0 = _ar + _br
    q1 = _x
    eptr += 1
    if(eptr < ne) {
      ei = e[eptr]
    }
  }
  while(fptr < nf) {
    a = fi
    b = q0
    x = a + b
    bv = x - a
    y = b - bv
    if(y) {
      g[count++] = y
    } 
    _x = q1 + x
    _bv = _x - q1
    _av = _x - _bv
    _br = x - _bv
    _ar = q1 - _av
    q0 = _ar + _br
    q1 = _x
    fptr += 1
    if(fptr < nf) {
      fi = f[fptr]
    }
  }
  if(q0) {
    g[count++] = q0
  }
  if(q1) {
    g[count++] = q1
  }
  if(!count) {
    g[count++] = 0.0  
  }
  g.length = count
  return g
}
},{}],11:[function(require,module,exports){
/*!
* svg.js - A lightweight library for manipulating and animating SVG.
* @version 2.3.7
* https://svgdotjs.github.io/
*
* @copyright Wout Fierens <wout@mick-wout.com>
* @license MIT
*
* BUILT: Sat Jan 14 2017 07:23:18 GMT+0100 (CET)
*/;
(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(function(){
      return factory(root, root.document)
    })
  } else if (typeof exports === 'object') {
    module.exports = root.document ? factory(root, root.document) : function(w){ return factory(w, w.document) }
  } else {
    root.SVG = factory(root, root.document)
  }
}(typeof window !== "undefined" ? window : this, function(window, document) {

// The main wrapping element
var SVG = this.SVG = function(element) {
  if (SVG.supported) {
    element = new SVG.Doc(element)

    if(!SVG.parser.draw)
      SVG.prepare()

    return element
  }
}

// Default namespaces
SVG.ns    = 'http://www.w3.org/2000/svg'
SVG.xmlns = 'http://www.w3.org/2000/xmlns/'
SVG.xlink = 'http://www.w3.org/1999/xlink'
SVG.svgjs = 'http://svgjs.com/svgjs'

// Svg support test
SVG.supported = (function() {
  return !! document.createElementNS &&
         !! document.createElementNS(SVG.ns,'svg').createSVGRect
})()

// Don't bother to continue if SVG is not supported
if (!SVG.supported) return false

// Element id sequence
SVG.did  = 1000

// Get next named element id
SVG.eid = function(name) {
  return 'Svgjs' + capitalize(name) + (SVG.did++)
}

// Method for element creation
SVG.create = function(name) {
  // create element
  var element = document.createElementNS(this.ns, name)

  // apply unique id
  element.setAttribute('id', this.eid(name))

  return element
}

// Method for extending objects
SVG.extend = function() {
  var modules, methods, key, i

  // Get list of modules
  modules = [].slice.call(arguments)

  // Get object with extensions
  methods = modules.pop()

  for (i = modules.length - 1; i >= 0; i--)
    if (modules[i])
      for (key in methods)
        modules[i].prototype[key] = methods[key]

  // Make sure SVG.Set inherits any newly added methods
  if (SVG.Set && SVG.Set.inherit)
    SVG.Set.inherit()
}

// Invent new element
SVG.invent = function(config) {
  // Create element initializer
  var initializer = typeof config.create == 'function' ?
    config.create :
    function() {
      this.constructor.call(this, SVG.create(config.create))
    }

  // Inherit prototype
  if (config.inherit)
    initializer.prototype = new config.inherit

  // Extend with methods
  if (config.extend)
    SVG.extend(initializer, config.extend)

  // Attach construct method to parent
  if (config.construct)
    SVG.extend(config.parent || SVG.Container, config.construct)

  return initializer
}

// Adopt existing svg elements
SVG.adopt = function(node) {
  // check for presence of node
  if (!node) return null

  // make sure a node isn't already adopted
  if (node.instance) return node.instance

  // initialize variables
  var element

  // adopt with element-specific settings
  if (node.nodeName == 'svg')
    element = node.parentNode instanceof SVGElement ? new SVG.Nested : new SVG.Doc
  else if (node.nodeName == 'linearGradient')
    element = new SVG.Gradient('linear')
  else if (node.nodeName == 'radialGradient')
    element = new SVG.Gradient('radial')
  else if (SVG[capitalize(node.nodeName)])
    element = new SVG[capitalize(node.nodeName)]
  else
    element = new SVG.Element(node)

  // ensure references
  element.type  = node.nodeName
  element.node  = node
  node.instance = element

  // SVG.Class specific preparations
  if (element instanceof SVG.Doc)
    element.namespace().defs()

  // pull svgjs data from the dom (getAttributeNS doesn't work in html5)
  element.setData(JSON.parse(node.getAttribute('svgjs:data')) || {})

  return element
}

// Initialize parsing element
SVG.prepare = function() {
  // Select document body and create invisible svg element
  var body = document.getElementsByTagName('body')[0]
    , draw = (body ? new SVG.Doc(body) :  new SVG.Doc(document.documentElement).nested()).size(2, 0)

  // Create parser object
  SVG.parser = {
    body: body || document.documentElement
  , draw: draw.style('opacity:0;position:fixed;left:100%;top:100%;overflow:hidden')
  , poly: draw.polyline().node
  , path: draw.path().node
  , native: SVG.create('svg')
  }
}

SVG.parser = {
  native: SVG.create('svg')
}

document.addEventListener('DOMContentLoaded', function() {
  if(!SVG.parser.draw)
    SVG.prepare()
}, false)

// Storage for regular expressions
SVG.regex = {
  // Parse unit value
  numberAndUnit:    /^([+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?)([a-z%]*)$/i

  // Parse hex value
, hex:              /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i

  // Parse rgb value
, rgb:              /rgb\((\d+),(\d+),(\d+)\)/

  // Parse reference id
, reference:        /#([a-z0-9\-_]+)/i

  // Parse matrix wrapper
, matrix:           /matrix\(|\)/g

  // Elements of a matrix
, matrixElements:   /,*\s+|,/

  // Whitespace
, whitespace:       /\s/g

  // Test hex value
, isHex:            /^#[a-f0-9]{3,6}$/i

  // Test rgb value
, isRgb:            /^rgb\(/

  // Test css declaration
, isCss:            /[^:]+:[^;]+;?/

  // Test for blank string
, isBlank:          /^(\s+)?$/

  // Test for numeric string
, isNumber:         /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i

  // Test for percent value
, isPercent:        /^-?[\d\.]+%$/

  // Test for image url
, isImage:          /\.(jpg|jpeg|png|gif|svg)(\?[^=]+.*)?/i

  // The following regex are used to parse the d attribute of a path

  // Replaces all negative exponents
, negExp:           /e\-/gi

  // Replaces all comma
, comma:            /,/g

  // Replaces all hyphens
, hyphen:           /\-/g

  // Replaces and tests for all path letters
, pathLetters:      /[MLHVCSQTAZ]/gi

  // yes we need this one, too
, isPathLetter:     /[MLHVCSQTAZ]/i

  // split at whitespaces
, whitespaces:      /\s+/

  // matches X
, X:                /X/g
}

SVG.utils = {
  // Map function
  map: function(array, block) {
    var i
      , il = array.length
      , result = []

    for (i = 0; i < il; i++)
      result.push(block(array[i]))

    return result
  }

  // Filter function
, filter: function(array, block) {
    var i
      , il = array.length
      , result = []

    for (i = 0; i < il; i++)
      if (block(array[i]))
        result.push(array[i])

    return result
  }

  // Degrees to radians
, radians: function(d) {
    return d % 360 * Math.PI / 180
  }

  // Radians to degrees
, degrees: function(r) {
    return r * 180 / Math.PI % 360
  }

, filterSVGElements: function(nodes) {
    return this.filter( nodes, function(el) { return el instanceof SVGElement })
  }

}

SVG.defaults = {
  // Default attribute values
  attrs: {
    // fill and stroke
    'fill-opacity':     1
  , 'stroke-opacity':   1
  , 'stroke-width':     0
  , 'stroke-linejoin':  'miter'
  , 'stroke-linecap':   'butt'
  , fill:               '#000000'
  , stroke:             '#000000'
  , opacity:            1
    // position
  , x:                  0
  , y:                  0
  , cx:                 0
  , cy:                 0
    // size
  , width:              0
  , height:             0
    // radius
  , r:                  0
  , rx:                 0
  , ry:                 0
    // gradient
  , offset:             0
  , 'stop-opacity':     1
  , 'stop-color':       '#000000'
    // text
  , 'font-size':        16
  , 'font-family':      'Helvetica, Arial, sans-serif'
  , 'text-anchor':      'start'
  }

}
// Module for color convertions
SVG.Color = function(color) {
  var match

  // initialize defaults
  this.r = 0
  this.g = 0
  this.b = 0

  if(!color) return

  // parse color
  if (typeof color === 'string') {
    if (SVG.regex.isRgb.test(color)) {
      // get rgb values
      match = SVG.regex.rgb.exec(color.replace(/\s/g,''))

      // parse numeric values
      this.r = parseInt(match[1])
      this.g = parseInt(match[2])
      this.b = parseInt(match[3])

    } else if (SVG.regex.isHex.test(color)) {
      // get hex values
      match = SVG.regex.hex.exec(fullHex(color))

      // parse numeric values
      this.r = parseInt(match[1], 16)
      this.g = parseInt(match[2], 16)
      this.b = parseInt(match[3], 16)

    }

  } else if (typeof color === 'object') {
    this.r = color.r
    this.g = color.g
    this.b = color.b

  }

}

SVG.extend(SVG.Color, {
  // Default to hex conversion
  toString: function() {
    return this.toHex()
  }
  // Build hex value
, toHex: function() {
    return '#'
      + compToHex(this.r)
      + compToHex(this.g)
      + compToHex(this.b)
  }
  // Build rgb value
, toRgb: function() {
    return 'rgb(' + [this.r, this.g, this.b].join() + ')'
  }
  // Calculate true brightness
, brightness: function() {
    return (this.r / 255 * 0.30)
         + (this.g / 255 * 0.59)
         + (this.b / 255 * 0.11)
  }
  // Make color morphable
, morph: function(color) {
    this.destination = new SVG.Color(color)

    return this
  }
  // Get morphed color at given position
, at: function(pos) {
    // make sure a destination is defined
    if (!this.destination) return this

    // normalise pos
    pos = pos < 0 ? 0 : pos > 1 ? 1 : pos

    // generate morphed color
    return new SVG.Color({
      r: ~~(this.r + (this.destination.r - this.r) * pos)
    , g: ~~(this.g + (this.destination.g - this.g) * pos)
    , b: ~~(this.b + (this.destination.b - this.b) * pos)
    })
  }

})

// Testers

// Test if given value is a color string
SVG.Color.test = function(color) {
  color += ''
  return SVG.regex.isHex.test(color)
      || SVG.regex.isRgb.test(color)
}

// Test if given value is a rgb object
SVG.Color.isRgb = function(color) {
  return color && typeof color.r == 'number'
               && typeof color.g == 'number'
               && typeof color.b == 'number'
}

// Test if given value is a color
SVG.Color.isColor = function(color) {
  return SVG.Color.isRgb(color) || SVG.Color.test(color)
}
// Module for array conversion
SVG.Array = function(array, fallback) {
  array = (array || []).valueOf()

  // if array is empty and fallback is provided, use fallback
  if (array.length == 0 && fallback)
    array = fallback.valueOf()

  // parse array
  this.value = this.parse(array)
}

SVG.extend(SVG.Array, {
  // Make array morphable
  morph: function(array) {
    this.destination = this.parse(array)

    // normalize length of arrays
    if (this.value.length != this.destination.length) {
      var lastValue       = this.value[this.value.length - 1]
        , lastDestination = this.destination[this.destination.length - 1]

      while(this.value.length > this.destination.length)
        this.destination.push(lastDestination)
      while(this.value.length < this.destination.length)
        this.value.push(lastValue)
    }

    return this
  }
  // Clean up any duplicate points
, settle: function() {
    // find all unique values
    for (var i = 0, il = this.value.length, seen = []; i < il; i++)
      if (seen.indexOf(this.value[i]) == -1)
        seen.push(this.value[i])

    // set new value
    return this.value = seen
  }
  // Get morphed array at given position
, at: function(pos) {
    // make sure a destination is defined
    if (!this.destination) return this

    // generate morphed array
    for (var i = 0, il = this.value.length, array = []; i < il; i++)
      array.push(this.value[i] + (this.destination[i] - this.value[i]) * pos)

    return new SVG.Array(array)
  }
  // Convert array to string
, toString: function() {
    return this.value.join(' ')
  }
  // Real value
, valueOf: function() {
    return this.value
  }
  // Parse whitespace separated string
, parse: function(array) {
    array = array.valueOf()

    // if already is an array, no need to parse it
    if (Array.isArray(array)) return array

    return this.split(array)
  }
  // Strip unnecessary whitespace
, split: function(string) {
    return string.trim().split(/\s+/)
  }
  // Reverse array
, reverse: function() {
    this.value.reverse()

    return this
  }

})
// Poly points array
SVG.PointArray = function(array, fallback) {
  this.constructor.call(this, array, fallback || [[0,0]])
}

// Inherit from SVG.Array
SVG.PointArray.prototype = new SVG.Array

SVG.extend(SVG.PointArray, {
  // Convert array to string
  toString: function() {
    // convert to a poly point string
    for (var i = 0, il = this.value.length, array = []; i < il; i++)
      array.push(this.value[i].join(','))

    return array.join(' ')
  }
  // Convert array to line object
, toLine: function() {
    return {
      x1: this.value[0][0]
    , y1: this.value[0][1]
    , x2: this.value[1][0]
    , y2: this.value[1][1]
    }
  }
  // Get morphed array at given position
, at: function(pos) {
    // make sure a destination is defined
    if (!this.destination) return this

    // generate morphed point string
    for (var i = 0, il = this.value.length, array = []; i < il; i++)
      array.push([
        this.value[i][0] + (this.destination[i][0] - this.value[i][0]) * pos
      , this.value[i][1] + (this.destination[i][1] - this.value[i][1]) * pos
      ])

    return new SVG.PointArray(array)
  }
  // Parse point string
, parse: function(array) {
    var points = []

    array = array.valueOf()

    // if already is an array, no need to parse it
    if (Array.isArray(array)) return array

    // parse points
    array = array.trim().split(/\s+|,/)

    // validate points - https://svgwg.org/svg2-draft/shapes.html#DataTypePoints
    // Odd number of coordinates is an error. In such cases, drop the last odd coordinate.
    if (array.length % 2 !== 0) array.pop()

    // wrap points in two-tuples and parse points as floats
    for(var i = 0, len = array.length; i < len; i = i + 2)
      points.push([ parseFloat(array[i]), parseFloat(array[i+1]) ])

    return points
  }
  // Move point string
, move: function(x, y) {
    var box = this.bbox()

    // get relative offset
    x -= box.x
    y -= box.y

    // move every point
    if (!isNaN(x) && !isNaN(y))
      for (var i = this.value.length - 1; i >= 0; i--)
        this.value[i] = [this.value[i][0] + x, this.value[i][1] + y]

    return this
  }
  // Resize poly string
, size: function(width, height) {
    var i, box = this.bbox()

    // recalculate position of all points according to new size
    for (i = this.value.length - 1; i >= 0; i--) {
      this.value[i][0] = ((this.value[i][0] - box.x) * width)  / box.width  + box.x
      this.value[i][1] = ((this.value[i][1] - box.y) * height) / box.height + box.y
    }

    return this
  }
  // Get bounding box of points
, bbox: function() {
    SVG.parser.poly.setAttribute('points', this.toString())

    return SVG.parser.poly.getBBox()
  }

})
// Path points array
SVG.PathArray = function(array, fallback) {
  this.constructor.call(this, array, fallback || [['M', 0, 0]])
}

// Inherit from SVG.Array
SVG.PathArray.prototype = new SVG.Array

SVG.extend(SVG.PathArray, {
  // Convert array to string
  toString: function() {
    return arrayToString(this.value)
  }
  // Move path string
, move: function(x, y) {
    // get bounding box of current situation
    var box = this.bbox()

    // get relative offset
    x -= box.x
    y -= box.y

    if (!isNaN(x) && !isNaN(y)) {
      // move every point
      for (var l, i = this.value.length - 1; i >= 0; i--) {
        l = this.value[i][0]

        if (l == 'M' || l == 'L' || l == 'T')  {
          this.value[i][1] += x
          this.value[i][2] += y

        } else if (l == 'H')  {
          this.value[i][1] += x

        } else if (l == 'V')  {
          this.value[i][1] += y

        } else if (l == 'C' || l == 'S' || l == 'Q')  {
          this.value[i][1] += x
          this.value[i][2] += y
          this.value[i][3] += x
          this.value[i][4] += y

          if (l == 'C')  {
            this.value[i][5] += x
            this.value[i][6] += y
          }

        } else if (l == 'A')  {
          this.value[i][6] += x
          this.value[i][7] += y
        }

      }
    }

    return this
  }
  // Resize path string
, size: function(width, height) {
    // get bounding box of current situation
    var i, l, box = this.bbox()

    // recalculate position of all points according to new size
    for (i = this.value.length - 1; i >= 0; i--) {
      l = this.value[i][0]

      if (l == 'M' || l == 'L' || l == 'T')  {
        this.value[i][1] = ((this.value[i][1] - box.x) * width)  / box.width  + box.x
        this.value[i][2] = ((this.value[i][2] - box.y) * height) / box.height + box.y

      } else if (l == 'H')  {
        this.value[i][1] = ((this.value[i][1] - box.x) * width)  / box.width  + box.x

      } else if (l == 'V')  {
        this.value[i][1] = ((this.value[i][1] - box.y) * height) / box.height + box.y

      } else if (l == 'C' || l == 'S' || l == 'Q')  {
        this.value[i][1] = ((this.value[i][1] - box.x) * width)  / box.width  + box.x
        this.value[i][2] = ((this.value[i][2] - box.y) * height) / box.height + box.y
        this.value[i][3] = ((this.value[i][3] - box.x) * width)  / box.width  + box.x
        this.value[i][4] = ((this.value[i][4] - box.y) * height) / box.height + box.y

        if (l == 'C')  {
          this.value[i][5] = ((this.value[i][5] - box.x) * width)  / box.width  + box.x
          this.value[i][6] = ((this.value[i][6] - box.y) * height) / box.height + box.y
        }

      } else if (l == 'A')  {
        // resize radii
        this.value[i][1] = (this.value[i][1] * width)  / box.width
        this.value[i][2] = (this.value[i][2] * height) / box.height

        // move position values
        this.value[i][6] = ((this.value[i][6] - box.x) * width)  / box.width  + box.x
        this.value[i][7] = ((this.value[i][7] - box.y) * height) / box.height + box.y
      }

    }

    return this
  }
  // Test if the passed path array use the same path data commands as this path array
, equalCommands: function(pathArray) {
    var i, il, equalCommands

    pathArray = new SVG.PathArray(pathArray)

    equalCommands = this.value.length === pathArray.value.length
    for(i = 0, il = this.value.length; equalCommands && i < il; i++) {
      equalCommands = this.value[i][0] === pathArray.value[i][0]
    }

    return equalCommands
  }
  // Make path array morphable
, morph: function(pathArray) {
    pathArray = new SVG.PathArray(pathArray)

    if(this.equalCommands(pathArray)) {
      this.destination = pathArray
    } else {
      this.destination = null
    }

    return this
  }
  // Get morphed path array at given position
, at: function(pos) {
    // make sure a destination is defined
    if (!this.destination) return this

    var sourceArray = this.value
      , destinationArray = this.destination.value
      , array = [], pathArray = new SVG.PathArray()
      , i, il, j, jl

    // Animate has specified in the SVG spec
    // See: https://www.w3.org/TR/SVG11/paths.html#PathElement
    for (i = 0, il = sourceArray.length; i < il; i++) {
      array[i] = [sourceArray[i][0]]
      for(j = 1, jl = sourceArray[i].length; j < jl; j++) {
        array[i][j] = sourceArray[i][j] + (destinationArray[i][j] - sourceArray[i][j]) * pos
      }
      // For the two flags of the elliptical arc command, the SVG spec say:
      // Flags and booleans are interpolated as fractions between zero and one, with any non-zero value considered to be a value of one/true
      // Elliptical arc command as an array followed by corresponding indexes:
      // ['A', rx, ry, x-axis-rotation, large-arc-flag, sweep-flag, x, y]
      //   0    1   2        3                 4             5      6  7
      if(array[i][0] === 'A') {
        array[i][4] = +(array[i][4] != 0)
        array[i][5] = +(array[i][5] != 0)
      }
    }

    // Directly modify the value of a path array, this is done this way for performance
    pathArray.value = array
    return pathArray
  }
  // Absolutize and parse path to array
, parse: function(array) {
    // if it's already a patharray, no need to parse it
    if (array instanceof SVG.PathArray) return array.valueOf()

    // prepare for parsing
    var i, x0, y0, s, seg, arr
      , x = 0
      , y = 0
      , paramCnt = { 'M':2, 'L':2, 'H':1, 'V':1, 'C':6, 'S':4, 'Q':4, 'T':2, 'A':7 }

    if(typeof array == 'string'){

      array = array
        .replace(SVG.regex.negExp, 'X')         // replace all negative exponents with certain char
        .replace(SVG.regex.pathLetters, ' $& ') // put some room between letters and numbers
        .replace(SVG.regex.hyphen, ' -')        // add space before hyphen
        .replace(SVG.regex.comma, ' ')          // unify all spaces
        .replace(SVG.regex.X, 'e-')             // add back the expoent
        .trim()                                 // trim
        .split(SVG.regex.whitespaces)           // split into array

      // at this place there could be parts like ['3.124.854.32'] because we could not determine the point as seperator till now
      // we fix this elements in the next loop
      for(i = array.length; --i;){
        if(array[i].indexOf('.') != array[i].lastIndexOf('.')){
          var split = array[i].split('.') // split at the point
          var first = [split.shift(), split.shift()].join('.') // join the first number together
          array.splice.apply(array, [i, 1].concat(first, split.map(function(el){ return '.'+el }))) // add first and all other entries back to array
        }
      }

    }else{
      array = array.reduce(function(prev, curr){
        return [].concat.apply(prev, curr)
      }, [])
    }

    // array now is an array containing all parts of a path e.g. ['M', '0', '0', 'L', '30', '30' ...]

    var arr = []

    do{

      // Test if we have a path letter
      if(SVG.regex.isPathLetter.test(array[0])){
        s = array[0]
        array.shift()
      // If last letter was a move command and we got no new, it defaults to [L]ine
      }else if(s == 'M'){
        s = 'L'
      }else if(s == 'm'){
        s = 'l'
      }

      // add path letter as first element
      seg = [s.toUpperCase()]

      // push all necessary parameters to segment
      for(i = 0; i < paramCnt[seg[0]]; ++i){
        seg.push(parseFloat(array.shift()))
      }

      // upper case
      if(s == seg[0]){

        if(s == 'M' || s == 'L' || s == 'C' || s == 'Q' || s == 'S' || s == 'T'){
          x = seg[paramCnt[seg[0]]-1]
          y = seg[paramCnt[seg[0]]]
        }else if(s == 'V'){
          y = seg[1]
        }else if(s == 'H'){
          x = seg[1]
        }else if(s == 'A'){
          x = seg[6]
          y = seg[7]
        }

      // lower case
      }else{

        // convert relative to absolute values
        if(s == 'm' || s == 'l' || s == 'c' || s == 's' || s == 'q' || s == 't'){

          seg[1] += x
          seg[2] += y

          if(seg[3] != null){
            seg[3] += x
            seg[4] += y
          }

          if(seg[5] != null){
            seg[5] += x
            seg[6] += y
          }

          // move pointer
          x = seg[paramCnt[seg[0]]-1]
          y = seg[paramCnt[seg[0]]]

        }else if(s == 'v'){
          seg[1] += y
          y = seg[1]
        }else if(s == 'h'){
          seg[1] += x
          x = seg[1]
        }else if(s == 'a'){
          seg[6] += x
          seg[7] += y
          x = seg[6]
          y = seg[7]
        }

      }

      if(seg[0] == 'M'){
        x0 = x
        y0 = y
      }

      if(seg[0] == 'Z'){
        x = x0
        y = y0
      }

      arr.push(seg)

    }while(array.length)

    return arr

  }
  // Get bounding box of path
, bbox: function() {
    SVG.parser.path.setAttribute('d', this.toString())

    return SVG.parser.path.getBBox()
  }

})

// Module for unit convertions
SVG.Number = SVG.invent({
  // Initialize
  create: function(value, unit) {
    // initialize defaults
    this.value = 0
    this.unit  = unit || ''

    // parse value
    if (typeof value === 'number') {
      // ensure a valid numeric value
      this.value = isNaN(value) ? 0 : !isFinite(value) ? (value < 0 ? -3.4e+38 : +3.4e+38) : value

    } else if (typeof value === 'string') {
      unit = value.match(SVG.regex.numberAndUnit)

      if (unit) {
        // make value numeric
        this.value = parseFloat(unit[1])

        // normalize
        if (unit[5] == '%')
          this.value /= 100
        else if (unit[5] == 's')
          this.value *= 1000

        // store unit
        this.unit = unit[5]
      }

    } else {
      if (value instanceof SVG.Number) {
        this.value = value.valueOf()
        this.unit  = value.unit
      }
    }

  }
  // Add methods
, extend: {
    // Stringalize
    toString: function() {
      return (
        this.unit == '%' ?
          ~~(this.value * 1e8) / 1e6:
        this.unit == 's' ?
          this.value / 1e3 :
          this.value
      ) + this.unit
    }
  , toJSON: function() {
      return this.toString()
    }
  , // Convert to primitive
    valueOf: function() {
      return this.value
    }
    // Add number
  , plus: function(number) {
      return new SVG.Number(this + new SVG.Number(number), this.unit)
    }
    // Subtract number
  , minus: function(number) {
      return this.plus(-new SVG.Number(number))
    }
    // Multiply number
  , times: function(number) {
      return new SVG.Number(this * new SVG.Number(number), this.unit)
    }
    // Divide number
  , divide: function(number) {
      return new SVG.Number(this / new SVG.Number(number), this.unit)
    }
    // Convert to different unit
  , to: function(unit) {
      var number = new SVG.Number(this)

      if (typeof unit === 'string')
        number.unit = unit

      return number
    }
    // Make number morphable
  , morph: function(number) {
      this.destination = new SVG.Number(number)

      return this
    }
    // Get morphed number at given position
  , at: function(pos) {
      // Make sure a destination is defined
      if (!this.destination) return this

      // Generate new morphed number
      return new SVG.Number(this.destination)
          .minus(this)
          .times(pos)
          .plus(this)
    }

  }
})

SVG.Element = SVG.invent({
  // Initialize node
  create: function(node) {
    // make stroke value accessible dynamically
    this._stroke = SVG.defaults.attrs.stroke

    // initialize data object
    this.dom = {}

    // create circular reference
    if (this.node = node) {
      this.type = node.nodeName
      this.node.instance = this

      // store current attribute value
      this._stroke = node.getAttribute('stroke') || this._stroke
    }
  }

  // Add class methods
, extend: {
    // Move over x-axis
    x: function(x) {
      return this.attr('x', x)
    }
    // Move over y-axis
  , y: function(y) {
      return this.attr('y', y)
    }
    // Move by center over x-axis
  , cx: function(x) {
      return x == null ? this.x() + this.width() / 2 : this.x(x - this.width() / 2)
    }
    // Move by center over y-axis
  , cy: function(y) {
      return y == null ? this.y() + this.height() / 2 : this.y(y - this.height() / 2)
    }
    // Move element to given x and y values
  , move: function(x, y) {
      return this.x(x).y(y)
    }
    // Move element by its center
  , center: function(x, y) {
      return this.cx(x).cy(y)
    }
    // Set width of element
  , width: function(width) {
      return this.attr('width', width)
    }
    // Set height of element
  , height: function(height) {
      return this.attr('height', height)
    }
    // Set element size to given width and height
  , size: function(width, height) {
      var p = proportionalSize(this, width, height)

      return this
        .width(new SVG.Number(p.width))
        .height(new SVG.Number(p.height))
    }
    // Clone element
  , clone: function(parent) {
      // clone element and assign new id
      var clone = assignNewId(this.node.cloneNode(true))

      // insert the clone in the given parent or after myself
      if(parent) parent.add(clone)
      else this.after(clone)

      return clone
    }
    // Remove element
  , remove: function() {
      if (this.parent())
        this.parent().removeElement(this)

      return this
    }
    // Replace element
  , replace: function(element) {
      this.after(element).remove()

      return element
    }
    // Add element to given container and return self
  , addTo: function(parent) {
      return parent.put(this)
    }
    // Add element to given container and return container
  , putIn: function(parent) {
      return parent.add(this)
    }
    // Get / set id
  , id: function(id) {
      return this.attr('id', id)
    }
    // Checks whether the given point inside the bounding box of the element
  , inside: function(x, y) {
      var box = this.bbox()

      return x > box.x
          && y > box.y
          && x < box.x + box.width
          && y < box.y + box.height
    }
    // Show element
  , show: function() {
      return this.style('display', '')
    }
    // Hide element
  , hide: function() {
      return this.style('display', 'none')
    }
    // Is element visible?
  , visible: function() {
      return this.style('display') != 'none'
    }
    // Return id on string conversion
  , toString: function() {
      return this.attr('id')
    }
    // Return array of classes on the node
  , classes: function() {
      var attr = this.attr('class')

      return attr == null ? [] : attr.trim().split(/\s+/)
    }
    // Return true if class exists on the node, false otherwise
  , hasClass: function(name) {
      return this.classes().indexOf(name) != -1
    }
    // Add class to the node
  , addClass: function(name) {
      if (!this.hasClass(name)) {
        var array = this.classes()
        array.push(name)
        this.attr('class', array.join(' '))
      }

      return this
    }
    // Remove class from the node
  , removeClass: function(name) {
      if (this.hasClass(name)) {
        this.attr('class', this.classes().filter(function(c) {
          return c != name
        }).join(' '))
      }

      return this
    }
    // Toggle the presence of a class on the node
  , toggleClass: function(name) {
      return this.hasClass(name) ? this.removeClass(name) : this.addClass(name)
    }
    // Get referenced element form attribute value
  , reference: function(attr) {
      return SVG.get(this.attr(attr))
    }
    // Returns the parent element instance
  , parent: function(type) {
      var parent = this

      // check for parent
      if(!parent.node.parentNode) return null

      // get parent element
      parent = SVG.adopt(parent.node.parentNode)

      if(!type) return parent

      // loop trough ancestors if type is given
      while(parent && parent.node instanceof SVGElement){
        if(typeof type === 'string' ? parent.matches(type) : parent instanceof type) return parent
        parent = SVG.adopt(parent.node.parentNode)
      }
    }
    // Get parent document
  , doc: function() {
      return this instanceof SVG.Doc ? this : this.parent(SVG.Doc)
    }
    // return array of all ancestors of given type up to the root svg
  , parents: function(type) {
      var parents = [], parent = this

      do{
        parent = parent.parent(type)
        if(!parent || !parent.node) break

        parents.push(parent)
      } while(parent.parent)

      return parents
    }
    // matches the element vs a css selector
  , matches: function(selector){
      return matches(this.node, selector)
    }
    // Returns the svg node to call native svg methods on it
  , native: function() {
      return this.node
    }
    // Import raw svg
  , svg: function(svg) {
      // create temporary holder
      var well = document.createElement('svg')

      // act as a setter if svg is given
      if (svg && this instanceof SVG.Parent) {
        // dump raw svg
        well.innerHTML = '<svg>' + svg.replace(/\n/, '').replace(/<(\w+)([^<]+?)\/>/g, '<$1$2></$1>') + '</svg>'

        // transplant nodes
        for (var i = 0, il = well.firstChild.childNodes.length; i < il; i++)
          this.node.appendChild(well.firstChild.firstChild)

      // otherwise act as a getter
      } else {
        // create a wrapping svg element in case of partial content
        well.appendChild(svg = document.createElement('svg'))

        // write svgjs data to the dom
        this.writeDataToDom()

        // insert a copy of this node
        svg.appendChild(this.node.cloneNode(true))

        // return target element
        return well.innerHTML.replace(/^<svg>/, '').replace(/<\/svg>$/, '')
      }

      return this
    }
  // write svgjs data to the dom
  , writeDataToDom: function() {

      // dump variables recursively
      if(this.each || this.lines){
        var fn = this.each ? this : this.lines();
        fn.each(function(){
          this.writeDataToDom()
        })
      }

      // remove previously set data
      this.node.removeAttribute('svgjs:data')

      if(Object.keys(this.dom).length)
        this.node.setAttribute('svgjs:data', JSON.stringify(this.dom)) // see #428

      return this
    }
  // set given data to the elements data property
  , setData: function(o){
      this.dom = o
      return this
    }
  , is: function(obj){
      return is(this, obj)
    }
  }
})

SVG.easing = {
  '-': function(pos){return pos}
, '<>':function(pos){return -Math.cos(pos * Math.PI) / 2 + 0.5}
, '>': function(pos){return  Math.sin(pos * Math.PI / 2)}
, '<': function(pos){return -Math.cos(pos * Math.PI / 2) + 1}
}

SVG.morph = function(pos){
  return function(from, to) {
    return new SVG.MorphObj(from, to).at(pos)
  }
}

SVG.Situation = SVG.invent({

  create: function(o){
    this.init = false
    this.reversed = false
    this.reversing = false

    this.duration = new SVG.Number(o.duration).valueOf()
    this.delay = new SVG.Number(o.delay).valueOf()

    this.start = +new Date() + this.delay
    this.finish = this.start + this.duration
    this.ease = o.ease

    // this.loop is incremented from 0 to this.loops
    // it is also incremented when in an infinite loop (when this.loops is true)
    this.loop = 0
    this.loops = false

    this.animations = {
      // functionToCall: [list of morphable objects]
      // e.g. move: [SVG.Number, SVG.Number]
    }

    this.attrs = {
      // holds all attributes which are not represented from a function svg.js provides
      // e.g. someAttr: SVG.Number
    }

    this.styles = {
      // holds all styles which should be animated
      // e.g. fill-color: SVG.Color
    }

    this.transforms = [
      // holds all transformations as transformation objects
      // e.g. [SVG.Rotate, SVG.Translate, SVG.Matrix]
    ]

    this.once = {
      // functions to fire at a specific position
      // e.g. "0.5": function foo(){}
    }

  }

})


SVG.FX = SVG.invent({

  create: function(element) {
    this._target = element
    this.situations = []
    this.active = false
    this.situation = null
    this.paused = false
    this.lastPos = 0
    this.pos = 0
    // The absolute position of an animation is its position in the context of its complete duration (including delay and loops)
    // When performing a delay, absPos is below 0 and when performing a loop, its value is above 1
    this.absPos = 0
    this._speed = 1
  }

, extend: {

    /**
     * sets or returns the target of this animation
     * @param o object || number In case of Object it holds all parameters. In case of number its the duration of the animation
     * @param ease function || string Function which should be used for easing or easing keyword
     * @param delay Number indicating the delay before the animation starts
     * @return target || this
     */
    animate: function(o, ease, delay){

      if(typeof o == 'object'){
        ease = o.ease
        delay = o.delay
        o = o.duration
      }

      var situation = new SVG.Situation({
        duration: o || 1000,
        delay: delay || 0,
        ease: SVG.easing[ease || '-'] || ease
      })

      this.queue(situation)

      return this
    }

    /**
     * sets a delay before the next element of the queue is called
     * @param delay Duration of delay in milliseconds
     * @return this.target()
     */
  , delay: function(delay){
      // The delay is performed by an empty situation with its duration
      // attribute set to the duration of the delay
      var situation = new SVG.Situation({
        duration: delay,
        delay: 0,
        ease: SVG.easing['-']
      })

      return this.queue(situation)
    }

    /**
     * sets or returns the target of this animation
     * @param null || target SVG.Element which should be set as new target
     * @return target || this
     */
  , target: function(target){
      if(target && target instanceof SVG.Element){
        this._target = target
        return this
      }

      return this._target
    }

    // returns the absolute position at a given time
  , timeToAbsPos: function(timestamp){
      return (timestamp - this.situation.start) / (this.situation.duration/this._speed)
    }

    // returns the timestamp from a given absolute positon
  , absPosToTime: function(absPos){
      return this.situation.duration/this._speed * absPos + this.situation.start
    }

    // starts the animationloop
  , startAnimFrame: function(){
      this.stopAnimFrame()
      this.animationFrame = requestAnimationFrame(function(){ this.step() }.bind(this))
    }

    // cancels the animationframe
  , stopAnimFrame: function(){
      cancelAnimationFrame(this.animationFrame)
    }

    // kicks off the animation - only does something when the queue is currently not active and at least one situation is set
  , start: function(){
      // dont start if already started
      if(!this.active && this.situation){
        this.active = true
        this.startCurrent()
      }

      return this
    }

    // start the current situation
  , startCurrent: function(){
      this.situation.start = +new Date + this.situation.delay/this._speed
      this.situation.finish = this.situation.start + this.situation.duration/this._speed
      return this.initAnimations().step()
    }

    /**
     * adds a function / Situation to the animation queue
     * @param fn function / situation to add
     * @return this
     */
  , queue: function(fn){
      if(typeof fn == 'function' || fn instanceof SVG.Situation)
        this.situations.push(fn)

      if(!this.situation) this.situation = this.situations.shift()

      return this
    }

    /**
     * pulls next element from the queue and execute it
     * @return this
     */
  , dequeue: function(){
      // stop current animation
      this.situation && this.situation.stop && this.situation.stop()

      // get next animation from queue
      this.situation = this.situations.shift()

      if(this.situation){
        if(this.situation instanceof SVG.Situation) {
          this.startCurrent()
        } else {
          // If it is not a SVG.Situation, then it is a function, we execute it
          this.situation.call(this)
        }
      }

      return this
    }

    // updates all animations to the current state of the element
    // this is important when one property could be changed from another property
  , initAnimations: function() {
      var i
      var s = this.situation

      if(s.init) return this

      for(i in s.animations){

        if(i == 'viewbox'){
          s.animations[i] = this.target().viewbox().morph(s.animations[i])
        }else{

          // TODO: this is not a clean clone of the array. We may have some unchecked references
          s.animations[i].value = (i == 'plot' ? this.target().array().value : this.target()[i]())

          // sometimes we get back an object and not the real value, fix this
          if(s.animations[i].value.value){
            s.animations[i].value = s.animations[i].value.value
          }

          if(s.animations[i].relative)
            s.animations[i].destination.value = s.animations[i].destination.value + s.animations[i].value

        }

      }

      for(i in s.attrs){
        if(s.attrs[i] instanceof SVG.Color){
          var color = new SVG.Color(this.target().attr(i))
          s.attrs[i].r = color.r
          s.attrs[i].g = color.g
          s.attrs[i].b = color.b
        }else{
          s.attrs[i].value = this.target().attr(i)// + s.attrs[i].value
        }
      }

      for(i in s.styles){
        s.styles[i].value = this.target().style(i)
      }

      s.initialTransformation = this.target().matrixify()

      s.init = true
      return this
    }
  , clearQueue: function(){
      this.situations = []
      return this
    }
  , clearCurrent: function(){
      this.situation = null
      return this
    }
    /** stops the animation immediately
     * @param jumpToEnd A Boolean indicating whether to complete the current animation immediately.
     * @param clearQueue A Boolean indicating whether to remove queued animation as well.
     * @return this
     */
  , stop: function(jumpToEnd, clearQueue){
      if(!this.active) this.start()

      if(clearQueue){
        this.clearQueue()
      }

      this.active = false

      if(jumpToEnd && this.situation){
        this.atEnd()
      }

      this.stopAnimFrame()

      return this.clearCurrent()
    }

    /** resets the element to the state where the current element has started
     * @return this
     */
  , reset: function(){
      if(this.situation){
        var temp = this.situation
        this.stop()
        this.situation = temp
        this.atStart()
      }
      return this
    }

    // Stop the currently-running animation, remove all queued animations, and complete all animations for the element.
  , finish: function(){

      this.stop(true, false)

      while(this.dequeue().situation && this.stop(true, false));

      this.clearQueue().clearCurrent()

      return this
    }

    // set the internal animation pointer at the start position, before any loops, and updates the visualisation
  , atStart: function() {
    return this.at(0, true)
  }

    // set the internal animation pointer at the end position, after all the loops, and updates the visualisation
  , atEnd: function() {
    if (this.situation.loops === true) {
      // If in a infinite loop, we end the current iteration
      return this.at(this.situation.loop+1, true)
    } else if(typeof this.situation.loops == 'number') {
      // If performing a finite number of loops, we go after all the loops
      return this.at(this.situation.loops, true)
    } else {
      // If no loops, we just go at the end
      return this.at(1, true)
    }
  }

    // set the internal animation pointer to the specified position and updates the visualisation
    // if isAbsPos is true, pos is treated as an absolute position
  , at: function(pos, isAbsPos){
      var durDivSpd = this.situation.duration/this._speed

      this.absPos = pos
      // If pos is not an absolute position, we convert it into one
      if (!isAbsPos) {
        if (this.situation.reversed) this.absPos = 1 - this.absPos
        this.absPos += this.situation.loop
      }

      this.situation.start = +new Date - this.absPos * durDivSpd
      this.situation.finish = this.situation.start + durDivSpd

      return this.step(true)
    }

    /**
     * sets or returns the speed of the animations
     * @param speed null || Number The new speed of the animations
     * @return Number || this
     */
  , speed: function(speed){
      if (speed === 0) return this.pause()

      if (speed) {
        this._speed = speed
        // We use an absolute position here so that speed can affect the delay before the animation
        return this.at(this.absPos, true)
      } else return this._speed
    }

    // Make loopable
  , loop: function(times, reverse) {
      var c = this.last()

      // store total loops
      c.loops = (times != null) ? times : true
      c.loop = 0

      if(reverse) c.reversing = true
      return this
    }

    // pauses the animation
  , pause: function(){
      this.paused = true
      this.stopAnimFrame()

      return this
    }

    // unpause the animation
  , play: function(){
      if(!this.paused) return this
      this.paused = false
      // We use an absolute position here so that the delay before the animation can be paused
      return this.at(this.absPos, true)
    }

    /**
     * toggle or set the direction of the animation
     * true sets direction to backwards while false sets it to forwards
     * @param reversed Boolean indicating whether to reverse the animation or not (default: toggle the reverse status)
     * @return this
     */
  , reverse: function(reversed){
      var c = this.last()

      if(typeof reversed == 'undefined') c.reversed = !c.reversed
      else c.reversed = reversed

      return this
    }


    /**
     * returns a float from 0-1 indicating the progress of the current animation
     * @param eased Boolean indicating whether the returned position should be eased or not
     * @return number
     */
  , progress: function(easeIt){
      return easeIt ? this.situation.ease(this.pos) : this.pos
    }

    /**
     * adds a callback function which is called when the current animation is finished
     * @param fn Function which should be executed as callback
     * @return number
     */
  , after: function(fn){
      var c = this.last()
        , wrapper = function wrapper(e){
            if(e.detail.situation == c){
              fn.call(this, c)
              this.off('finished.fx', wrapper) // prevent memory leak
            }
          }

      this.target().on('finished.fx', wrapper)
      return this
    }

    // adds a callback which is called whenever one animation step is performed
  , during: function(fn){
      var c = this.last()
        , wrapper = function(e){
            if(e.detail.situation == c){
              fn.call(this, e.detail.pos, SVG.morph(e.detail.pos), e.detail.eased, c)
            }
          }

      // see above
      this.target().off('during.fx', wrapper).on('during.fx', wrapper)

      return this.after(function(){
        this.off('during.fx', wrapper)
      })
    }

    // calls after ALL animations in the queue are finished
  , afterAll: function(fn){
      var wrapper = function wrapper(e){
            fn.call(this)
            this.off('allfinished.fx', wrapper)
          }

      // see above
      this.target().off('allfinished.fx', wrapper).on('allfinished.fx', wrapper)
      return this
    }

    // calls on every animation step for all animations
  , duringAll: function(fn){
      var wrapper = function(e){
            fn.call(this, e.detail.pos, SVG.morph(e.detail.pos), e.detail.eased, e.detail.situation)
          }

      this.target().off('during.fx', wrapper).on('during.fx', wrapper)

      return this.afterAll(function(){
        this.off('during.fx', wrapper)
      })
    }

  , last: function(){
      return this.situations.length ? this.situations[this.situations.length-1] : this.situation
    }

    // adds one property to the animations
  , add: function(method, args, type){
      this.last()[type || 'animations'][method] = args
      setTimeout(function(){this.start()}.bind(this), 0)
      return this
    }

    /** perform one step of the animation
     *  @param ignoreTime Boolean indicating whether to ignore time and use position directly or recalculate position based on time
     *  @return this
     */
  , step: function(ignoreTime){

      // convert current time to an absolute position
      if(!ignoreTime) this.absPos = this.timeToAbsPos(+new Date)

      // This part convert an absolute position to a position
      if(this.situation.loops !== false) {
        var absPos, absPosInt, lastLoop

        // If the absolute position is below 0, we just treat it as if it was 0
        absPos = Math.max(this.absPos, 0)
        absPosInt = Math.floor(absPos)

        if(this.situation.loops === true || absPosInt < this.situation.loops) {
          this.pos = absPos - absPosInt
          lastLoop = this.situation.loop
          this.situation.loop = absPosInt
        } else {
          this.absPos = this.situation.loops
          this.pos = 1
          // The -1 here is because we don't want to toggle reversed when all the loops have been completed
          lastLoop = this.situation.loop - 1
          this.situation.loop = this.situation.loops
        }

        if(this.situation.reversing) {
          // Toggle reversed if an odd number of loops as occured since the last call of step
          this.situation.reversed = this.situation.reversed != Boolean((this.situation.loop - lastLoop) % 2)
        }

      } else {
        // If there are no loop, the absolute position must not be above 1
        this.absPos = Math.min(this.absPos, 1)
        this.pos = this.absPos
      }

      // while the absolute position can be below 0, the position must not be below 0
      if(this.pos < 0) this.pos = 0

      if(this.situation.reversed) this.pos = 1 - this.pos


      // apply easing
      var eased = this.situation.ease(this.pos)

      // call once-callbacks
      for(var i in this.situation.once){
        if(i > this.lastPos && i <= eased){
          this.situation.once[i].call(this.target(), this.pos, eased)
          delete this.situation.once[i]
        }
      }

      // fire during callback with position, eased position and current situation as parameter
      if(this.active) this.target().fire('during', {pos: this.pos, eased: eased, fx: this, situation: this.situation})

      // the user may call stop or finish in the during callback
      // so make sure that we still have a valid situation
      if(!this.situation){
        return this
      }

      // apply the actual animation to every property
      this.eachAt()

      // do final code when situation is finished
      if((this.pos == 1 && !this.situation.reversed) || (this.situation.reversed && this.pos == 0)){

        // stop animation callback
        this.stopAnimFrame()

        // fire finished callback with current situation as parameter
        this.target().fire('finished', {fx:this, situation: this.situation})

        if(!this.situations.length){
          this.target().fire('allfinished')
          this.target().off('.fx') // there shouldnt be any binding left, but to make sure...
          this.active = false
        }

        // start next animation
        if(this.active) this.dequeue()
        else this.clearCurrent()

      }else if(!this.paused && this.active){
        // we continue animating when we are not at the end
        this.startAnimFrame()
      }

      // save last eased position for once callback triggering
      this.lastPos = eased
      return this

    }

    // calculates the step for every property and calls block with it
  , eachAt: function(){
      var i, at, self = this, target = this.target(), s = this.situation

      // apply animations which can be called trough a method
      for(i in s.animations){

        at = [].concat(s.animations[i]).map(function(el){
          return typeof el !== 'string' && el.at ? el.at(s.ease(self.pos), self.pos) : el
        })

        target[i].apply(target, at)

      }

      // apply animation which has to be applied with attr()
      for(i in s.attrs){

        at = [i].concat(s.attrs[i]).map(function(el){
          return typeof el !== 'string' && el.at ? el.at(s.ease(self.pos), self.pos) : el
        })

        target.attr.apply(target, at)

      }

      // apply animation which has to be applied with style()
      for(i in s.styles){

        at = [i].concat(s.styles[i]).map(function(el){
          return typeof el !== 'string' && el.at ? el.at(s.ease(self.pos), self.pos) : el
        })

        target.style.apply(target, at)

      }

      // animate initialTransformation which has to be chained
      if(s.transforms.length){

        // get initial initialTransformation
        at = s.initialTransformation
        for(i = 0, len = s.transforms.length; i < len; i++){

          // get next transformation in chain
          var a = s.transforms[i]

          // multiply matrix directly
          if(a instanceof SVG.Matrix){

            if(a.relative){
              at = at.multiply(new SVG.Matrix().morph(a).at(s.ease(this.pos)))
            }else{
              at = at.morph(a).at(s.ease(this.pos))
            }
            continue
          }

          // when transformation is absolute we have to reset the needed transformation first
          if(!a.relative)
            a.undo(at.extract())

          // and reapply it after
          at = at.multiply(a.at(s.ease(this.pos)))

        }

        // set new matrix on element
        target.matrix(at)
      }

      return this

    }


    // adds an once-callback which is called at a specific position and never again
  , once: function(pos, fn, isEased){

      if(!isEased)pos = this.situation.ease(pos)

      this.situation.once[pos] = fn

      return this
    }

  }

, parent: SVG.Element

  // Add method to parent elements
, construct: {
    // Get fx module or create a new one, then animate with given duration and ease
    animate: function(o, ease, delay) {
      return (this.fx || (this.fx = new SVG.FX(this))).animate(o, ease, delay)
    }
  , delay: function(delay){
      return (this.fx || (this.fx = new SVG.FX(this))).delay(delay)
    }
  , stop: function(jumpToEnd, clearQueue) {
      if (this.fx)
        this.fx.stop(jumpToEnd, clearQueue)

      return this
    }
  , finish: function() {
      if (this.fx)
        this.fx.finish()

      return this
    }
    // Pause current animation
  , pause: function() {
      if (this.fx)
        this.fx.pause()

      return this
    }
    // Play paused current animation
  , play: function() {
      if (this.fx)
        this.fx.play()

      return this
    }
    // Set/Get the speed of the animations
  , speed: function(speed) {
      if (this.fx)
        if (speed == null)
          return this.fx.speed()
        else
          this.fx.speed(speed)

      return this
    }
  }

})

// MorphObj is used whenever no morphable object is given
SVG.MorphObj = SVG.invent({

  create: function(from, to){
    // prepare color for morphing
    if(SVG.Color.isColor(to)) return new SVG.Color(from).morph(to)
    // prepare number for morphing
    if(SVG.regex.numberAndUnit.test(to)) return new SVG.Number(from).morph(to)

    // prepare for plain morphing
    this.value = 0
    this.destination = to
  }

, extend: {
    at: function(pos, real){
      return real < 1 ? this.value : this.destination
    },

    valueOf: function(){
      return this.value
    }
  }

})

SVG.extend(SVG.FX, {
  // Add animatable attributes
  attr: function(a, v, relative) {
    // apply attributes individually
    if (typeof a == 'object') {
      for (var key in a)
        this.attr(key, a[key])

    } else {
      // the MorphObj takes care about the right function used
      this.add(a, new SVG.MorphObj(null, v), 'attrs')
    }

    return this
  }
  // Add animatable styles
, style: function(s, v) {
    if (typeof s == 'object')
      for (var key in s)
        this.style(key, s[key])

    else
      this.add(s, new SVG.MorphObj(null, v), 'styles')

    return this
  }
  // Animatable x-axis
, x: function(x, relative) {
    if(this.target() instanceof SVG.G){
      this.transform({x:x}, relative)
      return this
    }

    var num = new SVG.Number().morph(x)
    num.relative = relative
    return this.add('x', num)
  }
  // Animatable y-axis
, y: function(y, relative) {
    if(this.target() instanceof SVG.G){
      this.transform({y:y}, relative)
      return this
    }

    var num = new SVG.Number().morph(y)
    num.relative = relative
    return this.add('y', num)
  }
  // Animatable center x-axis
, cx: function(x) {
    return this.add('cx', new SVG.Number().morph(x))
  }
  // Animatable center y-axis
, cy: function(y) {
    return this.add('cy', new SVG.Number().morph(y))
  }
  // Add animatable move
, move: function(x, y) {
    return this.x(x).y(y)
  }
  // Add animatable center
, center: function(x, y) {
    return this.cx(x).cy(y)
  }
  // Add animatable size
, size: function(width, height) {
    if (this.target() instanceof SVG.Text) {
      // animate font size for Text elements
      this.attr('font-size', width)

    } else {
      // animate bbox based size for all other elements
      var box

      if(!width || !height){
        box = this.target().bbox()
      }

      if(!width){
        width = box.width / box.height  * height
      }

      if(!height){
        height = box.height / box.width  * width
      }

      this.add('width' , new SVG.Number().morph(width))
          .add('height', new SVG.Number().morph(height))

    }

    return this
  }
  // Add animatable plot
, plot: function(p) {
    return this.add('plot', this.target().array().morph(p))
  }
  // Add leading method
, leading: function(value) {
    return this.target().leading ?
      this.add('leading', new SVG.Number().morph(value)) :
      this
  }
  // Add animatable viewbox
, viewbox: function(x, y, width, height) {
    if (this.target() instanceof SVG.Container) {
      this.add('viewbox', new SVG.ViewBox(x, y, width, height))
    }

    return this
  }
, update: function(o) {
    if (this.target() instanceof SVG.Stop) {
      if (typeof o == 'number' || o instanceof SVG.Number) {
        return this.update({
          offset:  arguments[0]
        , color:   arguments[1]
        , opacity: arguments[2]
        })
      }

      if (o.opacity != null) this.attr('stop-opacity', o.opacity)
      if (o.color   != null) this.attr('stop-color', o.color)
      if (o.offset  != null) this.attr('offset', o.offset)
    }

    return this
  }
})

SVG.BBox = SVG.invent({
  // Initialize
  create: function(element) {
    // get values if element is given
    if (element) {
      var box

      // yes this is ugly, but Firefox can be a bitch when it comes to elements that are not yet rendered
      try {

        // the element is NOT in the dom, throw error
        if(!document.documentElement.contains(element.node)) throw new Exception('Element not in the dom')

        // find native bbox
        box = element.node.getBBox()
      } catch(e) {
        if(element instanceof SVG.Shape){
          var clone = element.clone(SVG.parser.draw).show()
          box = clone.bbox()
          clone.remove()
        }else{
          box = {
            x:      element.node.clientLeft
          , y:      element.node.clientTop
          , width:  element.node.clientWidth
          , height: element.node.clientHeight
          }
        }
      }

      // plain x and y
      this.x = box.x
      this.y = box.y

      // plain width and height
      this.width  = box.width
      this.height = box.height
    }

    // add center, right and bottom
    fullBox(this)
  }

  // Define Parent
, parent: SVG.Element

  // Constructor
, construct: {
    // Get bounding box
    bbox: function() {
      return new SVG.BBox(this)
    }
  }

})

SVG.TBox = SVG.invent({
  // Initialize
  create: function(element) {
    // get values if element is given
    if (element) {
      var t   = element.ctm().extract()
        , box = element.bbox()

      // width and height including transformations
      this.width  = box.width  * t.scaleX
      this.height = box.height * t.scaleY

      // x and y including transformations
      this.x = box.x + t.x
      this.y = box.y + t.y
    }

    // add center, right and bottom
    fullBox(this)
  }

  // Define Parent
, parent: SVG.Element

  // Constructor
, construct: {
    // Get transformed bounding box
    tbox: function() {
      return new SVG.TBox(this)
    }
  }

})


SVG.RBox = SVG.invent({
  // Initialize
  create: function(element) {
    if (element) {
      var e    = element.doc().parent()
        , box  = element.node.getBoundingClientRect()
        , zoom = 1

      // get screen offset
      this.x = box.left
      this.y = box.top

      // subtract parent offset
      this.x -= e.offsetLeft
      this.y -= e.offsetTop

      while (e = e.offsetParent) {
        this.x -= e.offsetLeft
        this.y -= e.offsetTop
      }

      // calculate cumulative zoom from svg documents
      e = element
      while (e.parent && (e = e.parent())) {
        if (e.viewbox) {
          zoom *= e.viewbox().zoom
          this.x -= e.x() || 0
          this.y -= e.y() || 0
        }
      }

      // recalculate viewbox distortion
      this.width  = box.width  /= zoom
      this.height = box.height /= zoom
    }

    // add center, right and bottom
    fullBox(this)

    // offset by window scroll position, because getBoundingClientRect changes when window is scrolled
    this.x += window.pageXOffset
    this.y += window.pageYOffset
  }

  // define Parent
, parent: SVG.Element

  // Constructor
, construct: {
    // Get rect box
    rbox: function() {
      return new SVG.RBox(this)
    }
  }

})

// Add universal merge method
;[SVG.BBox, SVG.TBox, SVG.RBox].forEach(function(c) {

  SVG.extend(c, {
    // Merge rect box with another, return a new instance
    merge: function(box) {
      var b = new c()

      // merge boxes
      b.x      = Math.min(this.x, box.x)
      b.y      = Math.min(this.y, box.y)
      b.width  = Math.max(this.x + this.width,  box.x + box.width)  - b.x
      b.height = Math.max(this.y + this.height, box.y + box.height) - b.y

      return fullBox(b)
    }

  })

})

SVG.Matrix = SVG.invent({
  // Initialize
  create: function(source) {
    var i, base = arrayToMatrix([1, 0, 0, 1, 0, 0])

    // ensure source as object
    source = source instanceof SVG.Element ?
      source.matrixify() :
    typeof source === 'string' ?
      stringToMatrix(source) :
    arguments.length == 6 ?
      arrayToMatrix([].slice.call(arguments)) :
    typeof source === 'object' ?
      source : base

    // merge source
    for (i = abcdef.length - 1; i >= 0; --i)
      this[abcdef[i]] = source && typeof source[abcdef[i]] === 'number' ?
        source[abcdef[i]] : base[abcdef[i]]
  }

  // Add methods
, extend: {
    // Extract individual transformations
    extract: function() {
      // find delta transform points
      var px    = deltaTransformPoint(this, 0, 1)
        , py    = deltaTransformPoint(this, 1, 0)
        , skewX = 180 / Math.PI * Math.atan2(px.y, px.x) - 90

      return {
        // translation
        x:        this.e
      , y:        this.f
      , transformedX:(this.e * Math.cos(skewX * Math.PI / 180) + this.f * Math.sin(skewX * Math.PI / 180)) / Math.sqrt(this.a * this.a + this.b * this.b)
      , transformedY:(this.f * Math.cos(skewX * Math.PI / 180) + this.e * Math.sin(-skewX * Math.PI / 180)) / Math.sqrt(this.c * this.c + this.d * this.d)
        // skew
      , skewX:    -skewX
      , skewY:    180 / Math.PI * Math.atan2(py.y, py.x)
        // scale
      , scaleX:   Math.sqrt(this.a * this.a + this.b * this.b)
      , scaleY:   Math.sqrt(this.c * this.c + this.d * this.d)
        // rotation
      , rotation: skewX
      , a: this.a
      , b: this.b
      , c: this.c
      , d: this.d
      , e: this.e
      , f: this.f
      , matrix: new SVG.Matrix(this)
      }
    }
    // Clone matrix
  , clone: function() {
      return new SVG.Matrix(this)
    }
    // Morph one matrix into another
  , morph: function(matrix) {
      // store new destination
      this.destination = new SVG.Matrix(matrix)

      return this
    }
    // Get morphed matrix at a given position
  , at: function(pos) {
      // make sure a destination is defined
      if (!this.destination) return this

      // calculate morphed matrix at a given position
      var matrix = new SVG.Matrix({
        a: this.a + (this.destination.a - this.a) * pos
      , b: this.b + (this.destination.b - this.b) * pos
      , c: this.c + (this.destination.c - this.c) * pos
      , d: this.d + (this.destination.d - this.d) * pos
      , e: this.e + (this.destination.e - this.e) * pos
      , f: this.f + (this.destination.f - this.f) * pos
      })

      // process parametric rotation if present
      if (this.param && this.param.to) {
        // calculate current parametric position
        var param = {
          rotation: this.param.from.rotation + (this.param.to.rotation - this.param.from.rotation) * pos
        , cx:       this.param.from.cx
        , cy:       this.param.from.cy
        }

        // rotate matrix
        matrix = matrix.rotate(
          (this.param.to.rotation - this.param.from.rotation * 2) * pos
        , param.cx
        , param.cy
        )

        // store current parametric values
        matrix.param = param
      }

      return matrix
    }
    // Multiplies by given matrix
  , multiply: function(matrix) {
      return new SVG.Matrix(this.native().multiply(parseMatrix(matrix).native()))
    }
    // Inverses matrix
  , inverse: function() {
      return new SVG.Matrix(this.native().inverse())
    }
    // Translate matrix
  , translate: function(x, y) {
      return new SVG.Matrix(this.native().translate(x || 0, y || 0))
    }
    // Scale matrix
  , scale: function(x, y, cx, cy) {
      // support uniformal scale
      if (arguments.length == 1) {
        y = x
      } else if (arguments.length == 3) {
        cy = cx
        cx = y
        y = x
      }

      return this.around(cx, cy, new SVG.Matrix(x, 0, 0, y, 0, 0))
    }
    // Rotate matrix
  , rotate: function(r, cx, cy) {
      // convert degrees to radians
      r = SVG.utils.radians(r)

      return this.around(cx, cy, new SVG.Matrix(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0))
    }
    // Flip matrix on x or y, at a given offset
  , flip: function(a, o) {
      return a == 'x' ? this.scale(-1, 1, o, 0) : this.scale(1, -1, 0, o)
    }
    // Skew
  , skew: function(x, y, cx, cy) {
      // support uniformal skew
      if (arguments.length == 1) {
        y = x
      } else if (arguments.length == 3) {
        cy = cx
        cx = y
        y = x
      }

      // convert degrees to radians
      x = SVG.utils.radians(x)
      y = SVG.utils.radians(y)

      return this.around(cx, cy, new SVG.Matrix(1, Math.tan(y), Math.tan(x), 1, 0, 0))
    }
    // SkewX
  , skewX: function(x, cx, cy) {
      return this.skew(x, 0, cx, cy)
    }
    // SkewY
  , skewY: function(y, cx, cy) {
      return this.skew(0, y, cx, cy)
    }
    // Transform around a center point
  , around: function(cx, cy, matrix) {
      return this
        .multiply(new SVG.Matrix(1, 0, 0, 1, cx || 0, cy || 0))
        .multiply(matrix)
        .multiply(new SVG.Matrix(1, 0, 0, 1, -cx || 0, -cy || 0))
    }
    // Convert to native SVGMatrix
  , native: function() {
      // create new matrix
      var matrix = SVG.parser.native.createSVGMatrix()

      // update with current values
      for (var i = abcdef.length - 1; i >= 0; i--)
        matrix[abcdef[i]] = this[abcdef[i]]

      return matrix
    }
    // Convert matrix to string
  , toString: function() {
      return 'matrix(' + this.a + ',' + this.b + ',' + this.c + ',' + this.d + ',' + this.e + ',' + this.f + ')'
    }
  }

  // Define parent
, parent: SVG.Element

  // Add parent method
, construct: {
    // Get current matrix
    ctm: function() {
      return new SVG.Matrix(this.node.getCTM())
    },
    // Get current screen matrix
    screenCTM: function() {
      return new SVG.Matrix(this.node.getScreenCTM())
    }

  }

})

SVG.Point = SVG.invent({
  // Initialize
  create: function(x,y) {
    var i, source, base = {x:0, y:0}

    // ensure source as object
    source = Array.isArray(x) ?
      {x:x[0], y:x[1]} :
    typeof x === 'object' ?
      {x:x.x, y:x.y} :
    x != null ?
      {x:x, y:(y != null ? y : x)} : base // If y has no value, then x is used has its value

    // merge source
    this.x = source.x
    this.y = source.y
  }

  // Add methods
, extend: {
    // Clone point
    clone: function() {
      return new SVG.Point(this)
    }
    // Morph one point into another
  , morph: function(x, y) {
      // store new destination
      this.destination = new SVG.Point(x, y)

      return this
    }
    // Get morphed point at a given position
  , at: function(pos) {
      // make sure a destination is defined
      if (!this.destination) return this

      // calculate morphed matrix at a given position
      var point = new SVG.Point({
        x: this.x + (this.destination.x - this.x) * pos
      , y: this.y + (this.destination.y - this.y) * pos
      })

      return point
    }
    // Convert to native SVGPoint
  , native: function() {
      // create new point
      var point = SVG.parser.native.createSVGPoint()

      // update with current values
      point.x = this.x
      point.y = this.y

      return point
    }
    // transform point with matrix
  , transform: function(matrix) {
      return new SVG.Point(this.native().matrixTransform(matrix.native()))
    }

  }

})

SVG.extend(SVG.Element, {

  // Get point
  point: function(x, y) {
    return new SVG.Point(x,y).transform(this.screenCTM().inverse());
  }

})

SVG.extend(SVG.Element, {
  // Set svg element attribute
  attr: function(a, v, n) {
    // act as full getter
    if (a == null) {
      // get an object of attributes
      a = {}
      v = this.node.attributes
      for (n = v.length - 1; n >= 0; n--)
        a[v[n].nodeName] = SVG.regex.isNumber.test(v[n].nodeValue) ? parseFloat(v[n].nodeValue) : v[n].nodeValue

      return a

    } else if (typeof a == 'object') {
      // apply every attribute individually if an object is passed
      for (v in a) this.attr(v, a[v])

    } else if (v === null) {
        // remove value
        this.node.removeAttribute(a)

    } else if (v == null) {
      // act as a getter if the first and only argument is not an object
      v = this.node.getAttribute(a)
      return v == null ?
        SVG.defaults.attrs[a] :
      SVG.regex.isNumber.test(v) ?
        parseFloat(v) : v

    } else {
      // BUG FIX: some browsers will render a stroke if a color is given even though stroke width is 0
      if (a == 'stroke-width')
        this.attr('stroke', parseFloat(v) > 0 ? this._stroke : null)
      else if (a == 'stroke')
        this._stroke = v

      // convert image fill and stroke to patterns
      if (a == 'fill' || a == 'stroke') {
        if (SVG.regex.isImage.test(v))
          v = this.doc().defs().image(v, 0, 0)

        if (v instanceof SVG.Image)
          v = this.doc().defs().pattern(0, 0, function() {
            this.add(v)
          })
      }

      // ensure correct numeric values (also accepts NaN and Infinity)
      if (typeof v === 'number')
        v = new SVG.Number(v)

      // ensure full hex color
      else if (SVG.Color.isColor(v))
        v = new SVG.Color(v)

      // parse array values
      else if (Array.isArray(v))
        v = new SVG.Array(v)

      // store parametric transformation values locally
      else if (v instanceof SVG.Matrix && v.param)
        this.param = v.param

      // if the passed attribute is leading...
      if (a == 'leading') {
        // ... call the leading method instead
        if (this.leading)
          this.leading(v)
      } else {
        // set given attribute on node
        typeof n === 'string' ?
          this.node.setAttributeNS(n, a, v.toString()) :
          this.node.setAttribute(a, v.toString())
      }

      // rebuild if required
      if (this.rebuild && (a == 'font-size' || a == 'x'))
        this.rebuild(a, v)
    }

    return this
  }
})
SVG.extend(SVG.Element, {
  // Add transformations
  transform: function(o, relative) {
    // get target in case of the fx module, otherwise reference this
    var target = this
      , matrix

    // act as a getter
    if (typeof o !== 'object') {
      // get current matrix
      matrix = new SVG.Matrix(target).extract()

      return typeof o === 'string' ? matrix[o] : matrix
    }

    // get current matrix
    matrix = new SVG.Matrix(target)

    // ensure relative flag
    relative = !!relative || !!o.relative

    // act on matrix
    if (o.a != null) {
      matrix = relative ?
        // relative
        matrix.multiply(new SVG.Matrix(o)) :
        // absolute
        new SVG.Matrix(o)

    // act on rotation
    } else if (o.rotation != null) {
      // ensure centre point
      ensureCentre(o, target)

      // apply transformation
      matrix = relative ?
        // relative
        matrix.rotate(o.rotation, o.cx, o.cy) :
        // absolute
        matrix.rotate(o.rotation - matrix.extract().rotation, o.cx, o.cy)

    // act on scale
    } else if (o.scale != null || o.scaleX != null || o.scaleY != null) {
      // ensure centre point
      ensureCentre(o, target)

      // ensure scale values on both axes
      o.scaleX = o.scale != null ? o.scale : o.scaleX != null ? o.scaleX : 1
      o.scaleY = o.scale != null ? o.scale : o.scaleY != null ? o.scaleY : 1

      if (!relative) {
        // absolute; multiply inversed values
        var e = matrix.extract()
        o.scaleX = o.scaleX * 1 / e.scaleX
        o.scaleY = o.scaleY * 1 / e.scaleY
      }

      matrix = matrix.scale(o.scaleX, o.scaleY, o.cx, o.cy)

    // act on skew
    } else if (o.skew != null || o.skewX != null || o.skewY != null) {
      // ensure centre point
      ensureCentre(o, target)

      // ensure skew values on both axes
      o.skewX = o.skew != null ? o.skew : o.skewX != null ? o.skewX : 0
      o.skewY = o.skew != null ? o.skew : o.skewY != null ? o.skewY : 0

      if (!relative) {
        // absolute; reset skew values
        var e = matrix.extract()
        matrix = matrix.multiply(new SVG.Matrix().skew(e.skewX, e.skewY, o.cx, o.cy).inverse())
      }

      matrix = matrix.skew(o.skewX, o.skewY, o.cx, o.cy)

    // act on flip
    } else if (o.flip) {
      matrix = matrix.flip(
        o.flip
      , o.offset == null ? target.bbox()['c' + o.flip] : o.offset
      )

    // act on translate
    } else if (o.x != null || o.y != null) {
      if (relative) {
        // relative
        matrix = matrix.translate(o.x, o.y)
      } else {
        // absolute
        if (o.x != null) matrix.e = o.x
        if (o.y != null) matrix.f = o.y
      }
    }

    return this.attr('transform', matrix)
  }
})

SVG.extend(SVG.FX, {
  transform: function(o, relative) {
    // get target in case of the fx module, otherwise reference this
    var target = this.target()
      , matrix

    // act as a getter
    if (typeof o !== 'object') {
      // get current matrix
      matrix = new SVG.Matrix(target).extract()

      return typeof o === 'string' ? matrix[o] : matrix
    }

    // ensure relative flag
    relative = !!relative || !!o.relative

    // act on matrix
    if (o.a != null) {
      matrix = new SVG.Matrix(o)

    // act on rotation
    } else if (o.rotation != null) {
      // ensure centre point
      ensureCentre(o, target)

      // apply transformation
      matrix = new SVG.Rotate(o.rotation, o.cx, o.cy)

    // act on scale
    } else if (o.scale != null || o.scaleX != null || o.scaleY != null) {
      // ensure centre point
      ensureCentre(o, target)

      // ensure scale values on both axes
      o.scaleX = o.scale != null ? o.scale : o.scaleX != null ? o.scaleX : 1
      o.scaleY = o.scale != null ? o.scale : o.scaleY != null ? o.scaleY : 1

      matrix = new SVG.Scale(o.scaleX, o.scaleY, o.cx, o.cy)

    // act on skew
    } else if (o.skewX != null || o.skewY != null) {
      // ensure centre point
      ensureCentre(o, target)

      // ensure skew values on both axes
      o.skewX = o.skewX != null ? o.skewX : 0
      o.skewY = o.skewY != null ? o.skewY : 0

      matrix = new SVG.Skew(o.skewX, o.skewY, o.cx, o.cy)

    // act on flip
    } else if (o.flip) {
      matrix = new SVG.Matrix().morph(new SVG.Matrix().flip(
        o.flip
      , o.offset == null ? target.bbox()['c' + o.flip] : o.offset
      ))

    // act on translate
    } else if (o.x != null || o.y != null) {
      matrix = new SVG.Translate(o.x, o.y)
    }

    if(!matrix) return this

    matrix.relative = relative

    this.last().transforms.push(matrix)

    setTimeout(function(){this.start()}.bind(this), 0)

    return this
  }
})

SVG.extend(SVG.Element, {
  // Reset all transformations
  untransform: function() {
    return this.attr('transform', null)
  },
  // merge the whole transformation chain into one matrix and returns it
  matrixify: function() {

    var matrix = (this.attr('transform') || '')
      // split transformations
      .split(/\)\s*,?\s*/).slice(0,-1).map(function(str){
        // generate key => value pairs
        var kv = str.trim().split('(')
        return [kv[0], kv[1].split(SVG.regex.matrixElements).map(function(str){ return parseFloat(str) })]
      })
      // calculate every transformation into one matrix
      .reduce(function(matrix, transform){

        if(transform[0] == 'matrix') return matrix.multiply(arrayToMatrix(transform[1]))
        return matrix[transform[0]].apply(matrix, transform[1])

      }, new SVG.Matrix())

    return matrix
  },
  // add an element to another parent without changing the visual representation on the screen
  toParent: function(parent) {
    if(this == parent) return this
    var ctm = this.screenCTM()
    var temp = parent.rect(1,1)
    var pCtm = temp.screenCTM().inverse()
    temp.remove()

    this.addTo(parent).untransform().transform(pCtm.multiply(ctm))

    return this
  },
  // same as above with parent equals root-svg
  toDoc: function() {
    return this.toParent(this.doc())
  }

})

SVG.Transformation = SVG.invent({

  create: function(source, inversed){

    if(arguments.length > 1 && typeof inversed != 'boolean'){
      return this.create([].slice.call(arguments))
    }

    if(typeof source == 'object'){
      for(var i = 0, len = this.arguments.length; i < len; ++i){
        this[this.arguments[i]] = source[this.arguments[i]]
      }
    }

    if(Array.isArray(source)){
      for(var i = 0, len = this.arguments.length; i < len; ++i){
        this[this.arguments[i]] = source[i]
      }
    }

    this.inversed = false

    if(inversed === true){
      this.inversed = true
    }

  }

, extend: {

    at: function(pos){

      var params = []

      for(var i = 0, len = this.arguments.length; i < len; ++i){
        params.push(this[this.arguments[i]])
      }

      var m = this._undo || new SVG.Matrix()

      m = new SVG.Matrix().morph(SVG.Matrix.prototype[this.method].apply(m, params)).at(pos)

      return this.inversed ? m.inverse() : m

    }

  , undo: function(o){
      for(var i = 0, len = this.arguments.length; i < len; ++i){
        o[this.arguments[i]] = typeof this[this.arguments[i]] == 'undefined' ? 0 : o[this.arguments[i]]
      }

      // The method SVG.Matrix.extract which was used before calling this
      // method to obtain a value for the parameter o doesn't return a cx and
      // a cy so we use the ones that were provided to this object at its creation
      o.cx = this.cx
      o.cy = this.cy

      this._undo = new SVG[capitalize(this.method)](o, true).at(1)

      return this
    }

  }

})

SVG.Translate = SVG.invent({

  parent: SVG.Matrix
, inherit: SVG.Transformation

, create: function(source, inversed){
    if(typeof source == 'object') this.constructor.call(this, source, inversed)
    else this.constructor.call(this, [].slice.call(arguments))
  }

, extend: {
    arguments: ['transformedX', 'transformedY']
  , method: 'translate'
  }

})

SVG.Rotate = SVG.invent({

  parent: SVG.Matrix
, inherit: SVG.Transformation

, create: function(source, inversed){
    if(typeof source == 'object') this.constructor.call(this, source, inversed)
    else this.constructor.call(this, [].slice.call(arguments))
  }

, extend: {
    arguments: ['rotation', 'cx', 'cy']
  , method: 'rotate'
  , at: function(pos){
      var m = new SVG.Matrix().rotate(new SVG.Number().morph(this.rotation - (this._undo ? this._undo.rotation : 0)).at(pos), this.cx, this.cy)
      return this.inversed ? m.inverse() : m
    }
  , undo: function(o){
      this._undo = o
    }
  }

})

SVG.Scale = SVG.invent({

  parent: SVG.Matrix
, inherit: SVG.Transformation

, create: function(source, inversed){
    if(typeof source == 'object') this.constructor.call(this, source, inversed)
    else this.constructor.call(this, [].slice.call(arguments))
  }

, extend: {
    arguments: ['scaleX', 'scaleY', 'cx', 'cy']
  , method: 'scale'
  }

})

SVG.Skew = SVG.invent({

  parent: SVG.Matrix
, inherit: SVG.Transformation

, create: function(source, inversed){
    if(typeof source == 'object') this.constructor.call(this, source, inversed)
    else this.constructor.call(this, [].slice.call(arguments))
  }

, extend: {
    arguments: ['skewX', 'skewY', 'cx', 'cy']
  , method: 'skew'
  }

})

SVG.extend(SVG.Element, {
  // Dynamic style generator
  style: function(s, v) {
    if (arguments.length == 0) {
      // get full style
      return this.node.style.cssText || ''

    } else if (arguments.length < 2) {
      // apply every style individually if an object is passed
      if (typeof s == 'object') {
        for (v in s) this.style(v, s[v])

      } else if (SVG.regex.isCss.test(s)) {
        // parse css string
        s = s.split(';')

        // apply every definition individually
        for (var i = 0; i < s.length; i++) {
          v = s[i].split(':')
          this.style(v[0].replace(/\s+/g, ''), v[1])
        }
      } else {
        // act as a getter if the first and only argument is not an object
        return this.node.style[camelCase(s)]
      }

    } else {
      this.node.style[camelCase(s)] = v === null || SVG.regex.isBlank.test(v) ? '' : v
    }

    return this
  }
})
SVG.Parent = SVG.invent({
  // Initialize node
  create: function(element) {
    this.constructor.call(this, element)
  }

  // Inherit from
, inherit: SVG.Element

  // Add class methods
, extend: {
    // Returns all child elements
    children: function() {
      return SVG.utils.map(SVG.utils.filterSVGElements(this.node.childNodes), function(node) {
        return SVG.adopt(node)
      })
    }
    // Add given element at a position
  , add: function(element, i) {
      if (i == null)
        this.node.appendChild(element.node)
      else if (element.node != this.node.childNodes[i])
        this.node.insertBefore(element.node, this.node.childNodes[i])

      return this
    }
    // Basically does the same as `add()` but returns the added element instead
  , put: function(element, i) {
      this.add(element, i)
      return element
    }
    // Checks if the given element is a child
  , has: function(element) {
      return this.index(element) >= 0
    }
    // Gets index of given element
  , index: function(element) {
      return [].slice.call(this.node.childNodes).indexOf(element.node)
    }
    // Get a element at the given index
  , get: function(i) {
      return SVG.adopt(this.node.childNodes[i])
    }
    // Get first child
  , first: function() {
      return this.get(0)
    }
    // Get the last child
  , last: function() {
      return this.get(this.node.childNodes.length - 1)
    }
    // Iterates over all children and invokes a given block
  , each: function(block, deep) {
      var i, il
        , children = this.children()

      for (i = 0, il = children.length; i < il; i++) {
        if (children[i] instanceof SVG.Element)
          block.apply(children[i], [i, children])

        if (deep && (children[i] instanceof SVG.Container))
          children[i].each(block, deep)
      }

      return this
    }
    // Remove a given child
  , removeElement: function(element) {
      this.node.removeChild(element.node)

      return this
    }
    // Remove all elements in this container
  , clear: function() {
      // remove children
      while(this.node.hasChildNodes())
        this.node.removeChild(this.node.lastChild)

      // remove defs reference
      delete this._defs

      return this
    }
  , // Get defs
    defs: function() {
      return this.doc().defs()
    }
  }

})

SVG.extend(SVG.Parent, {

  ungroup: function(parent, depth) {
    if(depth === 0 || this instanceof SVG.Defs) return this

    parent = parent || (this instanceof SVG.Doc ? this : this.parent(SVG.Parent))
    depth = depth || Infinity

    this.each(function(){
      if(this instanceof SVG.Defs) return this
      if(this instanceof SVG.Parent) return this.ungroup(parent, depth-1)
      return this.toParent(parent)
    })

    this.node.firstChild || this.remove()

    return this
  },

  flatten: function(parent, depth) {
    return this.ungroup(parent, depth)
  }

})
SVG.Container = SVG.invent({
  // Initialize node
  create: function(element) {
    this.constructor.call(this, element)
  }

  // Inherit from
, inherit: SVG.Parent

})

SVG.ViewBox = SVG.invent({

  create: function(source) {
    var i, base = [0, 0, 0, 0]

    var x, y, width, height, box, view, we, he
      , wm   = 1 // width multiplier
      , hm   = 1 // height multiplier
      , reg  = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/gi

    if(source instanceof SVG.Element){

      we = source
      he = source
      view = (source.attr('viewBox') || '').match(reg)
      box = source.bbox

      // get dimensions of current node
      width  = new SVG.Number(source.width())
      height = new SVG.Number(source.height())

      // find nearest non-percentual dimensions
      while (width.unit == '%') {
        wm *= width.value
        width = new SVG.Number(we instanceof SVG.Doc ? we.parent().offsetWidth : we.parent().width())
        we = we.parent()
      }
      while (height.unit == '%') {
        hm *= height.value
        height = new SVG.Number(he instanceof SVG.Doc ? he.parent().offsetHeight : he.parent().height())
        he = he.parent()
      }

      // ensure defaults
      this.x      = 0
      this.y      = 0
      this.width  = width  * wm
      this.height = height * hm
      this.zoom   = 1

      if (view) {
        // get width and height from viewbox
        x      = parseFloat(view[0])
        y      = parseFloat(view[1])
        width  = parseFloat(view[2])
        height = parseFloat(view[3])

        // calculate zoom accoring to viewbox
        this.zoom = ((this.width / this.height) > (width / height)) ?
          this.height / height :
          this.width  / width

        // calculate real pixel dimensions on parent SVG.Doc element
        this.x      = x
        this.y      = y
        this.width  = width
        this.height = height

      }

    }else{

      // ensure source as object
      source = typeof source === 'string' ?
        source.match(reg).map(function(el){ return parseFloat(el) }) :
      Array.isArray(source) ?
        source :
      typeof source == 'object' ?
        [source.x, source.y, source.width, source.height] :
      arguments.length == 4 ?
        [].slice.call(arguments) :
        base

      this.x = source[0]
      this.y = source[1]
      this.width = source[2]
      this.height = source[3]
    }


  }

, extend: {

    toString: function() {
      return this.x + ' ' + this.y + ' ' + this.width + ' ' + this.height
    }
  , morph: function(v){

      var v = arguments.length == 1 ?
        [v.x, v.y, v.width, v.height] :
        [].slice.call(arguments)

      this.destination = new SVG.ViewBox(v)

      return this

    }

  , at: function(pos) {

    if(!this.destination) return this

    return new SVG.ViewBox([
        this.x + (this.destination.x - this.x) * pos
      , this.y + (this.destination.y - this.y) * pos
      , this.width + (this.destination.width - this.width) * pos
      , this.height + (this.destination.height - this.height) * pos
    ])

    }

  }

  // Define parent
, parent: SVG.Container

  // Add parent method
, construct: {

    // get/set viewbox
    viewbox: function(v) {
      if (arguments.length == 0)
        // act as a getter if there are no arguments
        return new SVG.ViewBox(this)

      // otherwise act as a setter
      v = arguments.length == 1 ?
        [v.x, v.y, v.width, v.height] :
        [].slice.call(arguments)

      return this.attr('viewBox', v)
    }

  }

})
// Add events to elements
;[  'click'
  , 'dblclick'
  , 'mousedown'
  , 'mouseup'
  , 'mouseover'
  , 'mouseout'
  , 'mousemove'
  // , 'mouseenter' -> not supported by IE
  // , 'mouseleave' -> not supported by IE
  , 'touchstart'
  , 'touchmove'
  , 'touchleave'
  , 'touchend'
  , 'touchcancel' ].forEach(function(event) {

  // add event to SVG.Element
  SVG.Element.prototype[event] = function(f) {
    var self = this

    // bind event to element rather than element node
    this.node['on' + event] = typeof f == 'function' ?
      function() { return f.apply(self, arguments) } : null

    return this
  }

})

// Initialize listeners stack
SVG.listeners = []
SVG.handlerMap = []
SVG.listenerId = 0

// Add event binder in the SVG namespace
SVG.on = function(node, event, listener, binding) {
  // create listener, get object-index
  var l     = listener.bind(binding || node.instance || node)
    , index = (SVG.handlerMap.indexOf(node) + 1 || SVG.handlerMap.push(node)) - 1
    , ev    = event.split('.')[0]
    , ns    = event.split('.')[1] || '*'


  // ensure valid object
  SVG.listeners[index]         = SVG.listeners[index]         || {}
  SVG.listeners[index][ev]     = SVG.listeners[index][ev]     || {}
  SVG.listeners[index][ev][ns] = SVG.listeners[index][ev][ns] || {}

  if(!listener._svgjsListenerId)
    listener._svgjsListenerId = ++SVG.listenerId

  // reference listener
  SVG.listeners[index][ev][ns][listener._svgjsListenerId] = l

  // add listener
  node.addEventListener(ev, l, false)
}

// Add event unbinder in the SVG namespace
SVG.off = function(node, event, listener) {
  var index = SVG.handlerMap.indexOf(node)
    , ev    = event && event.split('.')[0]
    , ns    = event && event.split('.')[1]

  if(index == -1) return

  if (listener) {
    if(typeof listener == 'function') listener = listener._svgjsListenerId
    if(!listener) return

    // remove listener reference
    if (SVG.listeners[index][ev] && SVG.listeners[index][ev][ns || '*']) {
      // remove listener
      node.removeEventListener(ev, SVG.listeners[index][ev][ns || '*'][listener], false)

      delete SVG.listeners[index][ev][ns || '*'][listener]
    }

  } else if (ns && ev) {
    // remove all listeners for a namespaced event
    if (SVG.listeners[index][ev] && SVG.listeners[index][ev][ns]) {
      for (listener in SVG.listeners[index][ev][ns])
        SVG.off(node, [ev, ns].join('.'), listener)

      delete SVG.listeners[index][ev][ns]
    }

  } else if (ns){
    // remove all listeners for a specific namespace
    for(event in SVG.listeners[index]){
        for(namespace in SVG.listeners[index][event]){
            if(ns === namespace){
                SVG.off(node, [event, ns].join('.'))
            }
        }
    }

  } else if (ev) {
    // remove all listeners for the event
    if (SVG.listeners[index][ev]) {
      for (namespace in SVG.listeners[index][ev])
        SVG.off(node, [ev, namespace].join('.'))

      delete SVG.listeners[index][ev]
    }

  } else {
    // remove all listeners on a given node
    for (event in SVG.listeners[index])
      SVG.off(node, event)

    delete SVG.listeners[index]

  }
}

//
SVG.extend(SVG.Element, {
  // Bind given event to listener
  on: function(event, listener, binding) {
    SVG.on(this.node, event, listener, binding)

    return this
  }
  // Unbind event from listener
, off: function(event, listener) {
    SVG.off(this.node, event, listener)

    return this
  }
  // Fire given event
, fire: function(event, data) {

    // Dispatch event
    if(event instanceof Event){
        this.node.dispatchEvent(event)
    }else{
        this.node.dispatchEvent(new CustomEvent(event, {detail:data}))
    }

    return this
  }
})

SVG.Defs = SVG.invent({
  // Initialize node
  create: 'defs'

  // Inherit from
, inherit: SVG.Container

})
SVG.G = SVG.invent({
  // Initialize node
  create: 'g'

  // Inherit from
, inherit: SVG.Container

  // Add class methods
, extend: {
    // Move over x-axis
    x: function(x) {
      return x == null ? this.transform('x') : this.transform({ x: x - this.x() }, true)
    }
    // Move over y-axis
  , y: function(y) {
      return y == null ? this.transform('y') : this.transform({ y: y - this.y() }, true)
    }
    // Move by center over x-axis
  , cx: function(x) {
      return x == null ? this.gbox().cx : this.x(x - this.gbox().width / 2)
    }
    // Move by center over y-axis
  , cy: function(y) {
      return y == null ? this.gbox().cy : this.y(y - this.gbox().height / 2)
    }
  , gbox: function() {

      var bbox  = this.bbox()
        , trans = this.transform()

      bbox.x  += trans.x
      bbox.x2 += trans.x
      bbox.cx += trans.x

      bbox.y  += trans.y
      bbox.y2 += trans.y
      bbox.cy += trans.y

      return bbox
    }
  }

  // Add parent method
, construct: {
    // Create a group element
    group: function() {
      return this.put(new SVG.G)
    }
  }
})

// ### This module adds backward / forward functionality to elements.

//
SVG.extend(SVG.Element, {
  // Get all siblings, including myself
  siblings: function() {
    return this.parent().children()
  }
  // Get the curent position siblings
, position: function() {
    return this.parent().index(this)
  }
  // Get the next element (will return null if there is none)
, next: function() {
    return this.siblings()[this.position() + 1]
  }
  // Get the next element (will return null if there is none)
, previous: function() {
    return this.siblings()[this.position() - 1]
  }
  // Send given element one step forward
, forward: function() {
    var i = this.position() + 1
      , p = this.parent()

    // move node one step forward
    p.removeElement(this).add(this, i)

    // make sure defs node is always at the top
    if (p instanceof SVG.Doc)
      p.node.appendChild(p.defs().node)

    return this
  }
  // Send given element one step backward
, backward: function() {
    var i = this.position()

    if (i > 0)
      this.parent().removeElement(this).add(this, i - 1)

    return this
  }
  // Send given element all the way to the front
, front: function() {
    var p = this.parent()

    // Move node forward
    p.node.appendChild(this.node)

    // Make sure defs node is always at the top
    if (p instanceof SVG.Doc)
      p.node.appendChild(p.defs().node)

    return this
  }
  // Send given element all the way to the back
, back: function() {
    if (this.position() > 0)
      this.parent().removeElement(this).add(this, 0)

    return this
  }
  // Inserts a given element before the targeted element
, before: function(element) {
    element.remove()

    var i = this.position()

    this.parent().add(element, i)

    return this
  }
  // Insters a given element after the targeted element
, after: function(element) {
    element.remove()

    var i = this.position()

    this.parent().add(element, i + 1)

    return this
  }

})
SVG.Mask = SVG.invent({
  // Initialize node
  create: function() {
    this.constructor.call(this, SVG.create('mask'))

    // keep references to masked elements
    this.targets = []
  }

  // Inherit from
, inherit: SVG.Container

  // Add class methods
, extend: {
    // Unmask all masked elements and remove itself
    remove: function() {
      // unmask all targets
      for (var i = this.targets.length - 1; i >= 0; i--)
        if (this.targets[i])
          this.targets[i].unmask()
      this.targets = []

      // remove mask from parent
      this.parent().removeElement(this)

      return this
    }
  }

  // Add parent method
, construct: {
    // Create masking element
    mask: function() {
      return this.defs().put(new SVG.Mask)
    }
  }
})


SVG.extend(SVG.Element, {
  // Distribute mask to svg element
  maskWith: function(element) {
    // use given mask or create a new one
    this.masker = element instanceof SVG.Mask ? element : this.parent().mask().add(element)

    // store reverence on self in mask
    this.masker.targets.push(this)

    // apply mask
    return this.attr('mask', 'url("#' + this.masker.attr('id') + '")')
  }
  // Unmask element
, unmask: function() {
    delete this.masker
    return this.attr('mask', null)
  }

})

SVG.ClipPath = SVG.invent({
  // Initialize node
  create: function() {
    this.constructor.call(this, SVG.create('clipPath'))

    // keep references to clipped elements
    this.targets = []
  }

  // Inherit from
, inherit: SVG.Container

  // Add class methods
, extend: {
    // Unclip all clipped elements and remove itself
    remove: function() {
      // unclip all targets
      for (var i = this.targets.length - 1; i >= 0; i--)
        if (this.targets[i])
          this.targets[i].unclip()
      this.targets = []

      // remove clipPath from parent
      this.parent().removeElement(this)

      return this
    }
  }

  // Add parent method
, construct: {
    // Create clipping element
    clip: function() {
      return this.defs().put(new SVG.ClipPath)
    }
  }
})

//
SVG.extend(SVG.Element, {
  // Distribute clipPath to svg element
  clipWith: function(element) {
    // use given clip or create a new one
    this.clipper = element instanceof SVG.ClipPath ? element : this.parent().clip().add(element)

    // store reverence on self in mask
    this.clipper.targets.push(this)

    // apply mask
    return this.attr('clip-path', 'url("#' + this.clipper.attr('id') + '")')
  }
  // Unclip element
, unclip: function() {
    delete this.clipper
    return this.attr('clip-path', null)
  }

})
SVG.Gradient = SVG.invent({
  // Initialize node
  create: function(type) {
    this.constructor.call(this, SVG.create(type + 'Gradient'))

    // store type
    this.type = type
  }

  // Inherit from
, inherit: SVG.Container

  // Add class methods
, extend: {
    // Add a color stop
    at: function(offset, color, opacity) {
      return this.put(new SVG.Stop).update(offset, color, opacity)
    }
    // Update gradient
  , update: function(block) {
      // remove all stops
      this.clear()

      // invoke passed block
      if (typeof block == 'function')
        block.call(this, this)

      return this
    }
    // Return the fill id
  , fill: function() {
      return 'url(#' + this.id() + ')'
    }
    // Alias string convertion to fill
  , toString: function() {
      return this.fill()
    }
    // custom attr to handle transform
  , attr: function(a, b, c) {
      if(a == 'transform') a = 'gradientTransform'
      return SVG.Container.prototype.attr.call(this, a, b, c)
    }
  }

  // Add parent method
, construct: {
    // Create gradient element in defs
    gradient: function(type, block) {
      return this.defs().gradient(type, block)
    }
  }
})

// Add animatable methods to both gradient and fx module
SVG.extend(SVG.Gradient, SVG.FX, {
  // From position
  from: function(x, y) {
    return (this._target || this).type == 'radial' ?
      this.attr({ fx: new SVG.Number(x), fy: new SVG.Number(y) }) :
      this.attr({ x1: new SVG.Number(x), y1: new SVG.Number(y) })
  }
  // To position
, to: function(x, y) {
    return (this._target || this).type == 'radial' ?
      this.attr({ cx: new SVG.Number(x), cy: new SVG.Number(y) }) :
      this.attr({ x2: new SVG.Number(x), y2: new SVG.Number(y) })
  }
})

// Base gradient generation
SVG.extend(SVG.Defs, {
  // define gradient
  gradient: function(type, block) {
    return this.put(new SVG.Gradient(type)).update(block)
  }

})

SVG.Stop = SVG.invent({
  // Initialize node
  create: 'stop'

  // Inherit from
, inherit: SVG.Element

  // Add class methods
, extend: {
    // add color stops
    update: function(o) {
      if (typeof o == 'number' || o instanceof SVG.Number) {
        o = {
          offset:  arguments[0]
        , color:   arguments[1]
        , opacity: arguments[2]
        }
      }

      // set attributes
      if (o.opacity != null) this.attr('stop-opacity', o.opacity)
      if (o.color   != null) this.attr('stop-color', o.color)
      if (o.offset  != null) this.attr('offset', new SVG.Number(o.offset))

      return this
    }
  }

})

SVG.Pattern = SVG.invent({
  // Initialize node
  create: 'pattern'

  // Inherit from
, inherit: SVG.Container

  // Add class methods
, extend: {
    // Return the fill id
    fill: function() {
      return 'url(#' + this.id() + ')'
    }
    // Update pattern by rebuilding
  , update: function(block) {
      // remove content
      this.clear()

      // invoke passed block
      if (typeof block == 'function')
        block.call(this, this)

      return this
    }
    // Alias string convertion to fill
  , toString: function() {
      return this.fill()
    }
    // custom attr to handle transform
  , attr: function(a, b, c) {
      if(a == 'transform') a = 'patternTransform'
      return SVG.Container.prototype.attr.call(this, a, b, c)
    }

  }

  // Add parent method
, construct: {
    // Create pattern element in defs
    pattern: function(width, height, block) {
      return this.defs().pattern(width, height, block)
    }
  }
})

SVG.extend(SVG.Defs, {
  // Define gradient
  pattern: function(width, height, block) {
    return this.put(new SVG.Pattern).update(block).attr({
      x:            0
    , y:            0
    , width:        width
    , height:       height
    , patternUnits: 'userSpaceOnUse'
    })
  }

})
SVG.Doc = SVG.invent({
  // Initialize node
  create: function(element) {
    if (element) {
      // ensure the presence of a dom element
      element = typeof element == 'string' ?
        document.getElementById(element) :
        element

      // If the target is an svg element, use that element as the main wrapper.
      // This allows svg.js to work with svg documents as well.
      if (element.nodeName == 'svg') {
        this.constructor.call(this, element)
      } else {
        this.constructor.call(this, SVG.create('svg'))
        element.appendChild(this.node)
        this.size('100%', '100%')
      }

      // set svg element attributes and ensure defs node
      this.namespace().defs()
    }
  }

  // Inherit from
, inherit: SVG.Container

  // Add class methods
, extend: {
    // Add namespaces
    namespace: function() {
      return this
        .attr({ xmlns: SVG.ns, version: '1.1' })
        .attr('xmlns:xlink', SVG.xlink, SVG.xmlns)
        .attr('xmlns:svgjs', SVG.svgjs, SVG.xmlns)
    }
    // Creates and returns defs element
  , defs: function() {
      if (!this._defs) {
        var defs

        // Find or create a defs element in this instance
        if (defs = this.node.getElementsByTagName('defs')[0])
          this._defs = SVG.adopt(defs)
        else
          this._defs = new SVG.Defs

        // Make sure the defs node is at the end of the stack
        this.node.appendChild(this._defs.node)
      }

      return this._defs
    }
    // custom parent method
  , parent: function() {
      return this.node.parentNode.nodeName == '#document' ? null : this.node.parentNode
    }
    // Fix for possible sub-pixel offset. See:
    // https://bugzilla.mozilla.org/show_bug.cgi?id=608812
  , spof: function(spof) {
      var pos = this.node.getScreenCTM()

      if (pos)
        this
          .style('left', (-pos.e % 1) + 'px')
          .style('top',  (-pos.f % 1) + 'px')

      return this
    }

      // Removes the doc from the DOM
  , remove: function() {
      if(this.parent()) {
        this.parent().removeChild(this.node);
      }

      return this;
    }
  }

})

SVG.Shape = SVG.invent({
  // Initialize node
  create: function(element) {
    this.constructor.call(this, element)
  }

  // Inherit from
, inherit: SVG.Element

})

SVG.Bare = SVG.invent({
  // Initialize
  create: function(element, inherit) {
    // construct element
    this.constructor.call(this, SVG.create(element))

    // inherit custom methods
    if (inherit)
      for (var method in inherit.prototype)
        if (typeof inherit.prototype[method] === 'function')
          this[method] = inherit.prototype[method]
  }

  // Inherit from
, inherit: SVG.Element

  // Add methods
, extend: {
    // Insert some plain text
    words: function(text) {
      // remove contents
      while (this.node.hasChildNodes())
        this.node.removeChild(this.node.lastChild)

      // create text node
      this.node.appendChild(document.createTextNode(text))

      return this
    }
  }
})


SVG.extend(SVG.Parent, {
  // Create an element that is not described by SVG.js
  element: function(element, inherit) {
    return this.put(new SVG.Bare(element, inherit))
  }
  // Add symbol element
, symbol: function() {
    return this.defs().element('symbol', SVG.Container)
  }

})
SVG.Use = SVG.invent({
  // Initialize node
  create: 'use'

  // Inherit from
, inherit: SVG.Shape

  // Add class methods
, extend: {
    // Use element as a reference
    element: function(element, file) {
      // Set lined element
      return this.attr('href', (file || '') + '#' + element, SVG.xlink)
    }
  }

  // Add parent method
, construct: {
    // Create a use element
    use: function(element, file) {
      return this.put(new SVG.Use).element(element, file)
    }
  }
})
SVG.Rect = SVG.invent({
  // Initialize node
  create: 'rect'

  // Inherit from
, inherit: SVG.Shape

  // Add parent method
, construct: {
    // Create a rect element
    rect: function(width, height) {
      return this.put(new SVG.Rect()).size(width, height)
    }
  }
})
SVG.Circle = SVG.invent({
  // Initialize node
  create: 'circle'

  // Inherit from
, inherit: SVG.Shape

  // Add parent method
, construct: {
    // Create circle element, based on ellipse
    circle: function(size) {
      return this.put(new SVG.Circle).rx(new SVG.Number(size).divide(2)).move(0, 0)
    }
  }
})

SVG.extend(SVG.Circle, SVG.FX, {
  // Radius x value
  rx: function(rx) {
    return this.attr('r', rx)
  }
  // Alias radius x value
, ry: function(ry) {
    return this.rx(ry)
  }
})

SVG.Ellipse = SVG.invent({
  // Initialize node
  create: 'ellipse'

  // Inherit from
, inherit: SVG.Shape

  // Add parent method
, construct: {
    // Create an ellipse
    ellipse: function(width, height) {
      return this.put(new SVG.Ellipse).size(width, height).move(0, 0)
    }
  }
})

SVG.extend(SVG.Ellipse, SVG.Rect, SVG.FX, {
  // Radius x value
  rx: function(rx) {
    return this.attr('rx', rx)
  }
  // Radius y value
, ry: function(ry) {
    return this.attr('ry', ry)
  }
})

// Add common method
SVG.extend(SVG.Circle, SVG.Ellipse, {
    // Move over x-axis
    x: function(x) {
      return x == null ? this.cx() - this.rx() : this.cx(x + this.rx())
    }
    // Move over y-axis
  , y: function(y) {
      return y == null ? this.cy() - this.ry() : this.cy(y + this.ry())
    }
    // Move by center over x-axis
  , cx: function(x) {
      return x == null ? this.attr('cx') : this.attr('cx', x)
    }
    // Move by center over y-axis
  , cy: function(y) {
      return y == null ? this.attr('cy') : this.attr('cy', y)
    }
    // Set width of element
  , width: function(width) {
      return width == null ? this.rx() * 2 : this.rx(new SVG.Number(width).divide(2))
    }
    // Set height of element
  , height: function(height) {
      return height == null ? this.ry() * 2 : this.ry(new SVG.Number(height).divide(2))
    }
    // Custom size function
  , size: function(width, height) {
      var p = proportionalSize(this, width, height)

      return this
        .rx(new SVG.Number(p.width).divide(2))
        .ry(new SVG.Number(p.height).divide(2))
    }
})
SVG.Line = SVG.invent({
  // Initialize node
  create: 'line'

  // Inherit from
, inherit: SVG.Shape

  // Add class methods
, extend: {
    // Get array
    array: function() {
      return new SVG.PointArray([
        [ this.attr('x1'), this.attr('y1') ]
      , [ this.attr('x2'), this.attr('y2') ]
      ])
    }
    // Overwrite native plot() method
  , plot: function(x1, y1, x2, y2) {
      if (typeof y1 !== 'undefined')
        x1 = { x1: x1, y1: y1, x2: x2, y2: y2 }
      else
        x1 = new SVG.PointArray(x1).toLine()

      return this.attr(x1)
    }
    // Move by left top corner
  , move: function(x, y) {
      return this.attr(this.array().move(x, y).toLine())
    }
    // Set element size to given width and height
  , size: function(width, height) {
      var p = proportionalSize(this, width, height)

      return this.attr(this.array().size(p.width, p.height).toLine())
    }
  }

  // Add parent method
, construct: {
    // Create a line element
    line: function(x1, y1, x2, y2) {
      return this.put(new SVG.Line).plot(x1, y1, x2, y2)
    }
  }
})

SVG.Polyline = SVG.invent({
  // Initialize node
  create: 'polyline'

  // Inherit from
, inherit: SVG.Shape

  // Add parent method
, construct: {
    // Create a wrapped polyline element
    polyline: function(p) {
      return this.put(new SVG.Polyline).plot(p)
    }
  }
})

SVG.Polygon = SVG.invent({
  // Initialize node
  create: 'polygon'

  // Inherit from
, inherit: SVG.Shape

  // Add parent method
, construct: {
    // Create a wrapped polygon element
    polygon: function(p) {
      return this.put(new SVG.Polygon).plot(p)
    }
  }
})

// Add polygon-specific functions
SVG.extend(SVG.Polyline, SVG.Polygon, {
  // Get array
  array: function() {
    return this._array || (this._array = new SVG.PointArray(this.attr('points')))
  }
  // Plot new path
, plot: function(p) {
    return this.attr('points', (this._array = new SVG.PointArray(p)))
  }
  // Move by left top corner
, move: function(x, y) {
    return this.attr('points', this.array().move(x, y))
  }
  // Set element size to given width and height
, size: function(width, height) {
    var p = proportionalSize(this, width, height)

    return this.attr('points', this.array().size(p.width, p.height))
  }

})
// unify all point to point elements
SVG.extend(SVG.Line, SVG.Polyline, SVG.Polygon, {
  // Define morphable array
  morphArray:  SVG.PointArray
  // Move by left top corner over x-axis
, x: function(x) {
    return x == null ? this.bbox().x : this.move(x, this.bbox().y)
  }
  // Move by left top corner over y-axis
, y: function(y) {
    return y == null ? this.bbox().y : this.move(this.bbox().x, y)
  }
  // Set width of element
, width: function(width) {
    var b = this.bbox()

    return width == null ? b.width : this.size(width, b.height)
  }
  // Set height of element
, height: function(height) {
    var b = this.bbox()

    return height == null ? b.height : this.size(b.width, height)
  }
})
SVG.Path = SVG.invent({
  // Initialize node
  create: 'path'

  // Inherit from
, inherit: SVG.Shape

  // Add class methods
, extend: {
    // Define morphable array
    morphArray:  SVG.PathArray
    // Get array
  , array: function() {
      return this._array || (this._array = new SVG.PathArray(this.attr('d')))
    }
    // Plot new poly points
  , plot: function(p) {
      return this.attr('d', (this._array = new SVG.PathArray(p)))
    }
    // Move by left top corner
  , move: function(x, y) {
      return this.attr('d', this.array().move(x, y))
    }
    // Move by left top corner over x-axis
  , x: function(x) {
      return x == null ? this.bbox().x : this.move(x, this.bbox().y)
    }
    // Move by left top corner over y-axis
  , y: function(y) {
      return y == null ? this.bbox().y : this.move(this.bbox().x, y)
    }
    // Set element size to given width and height
  , size: function(width, height) {
      var p = proportionalSize(this, width, height)

      return this.attr('d', this.array().size(p.width, p.height))
    }
    // Set width of element
  , width: function(width) {
      return width == null ? this.bbox().width : this.size(width, this.bbox().height)
    }
    // Set height of element
  , height: function(height) {
      return height == null ? this.bbox().height : this.size(this.bbox().width, height)
    }

  }

  // Add parent method
, construct: {
    // Create a wrapped path element
    path: function(d) {
      return this.put(new SVG.Path).plot(d)
    }
  }
})
SVG.Image = SVG.invent({
  // Initialize node
  create: 'image'

  // Inherit from
, inherit: SVG.Shape

  // Add class methods
, extend: {
    // (re)load image
    load: function(url) {
      if (!url) return this

      var self = this
        , img  = document.createElement('img')

      // preload image
      img.onload = function() {
        var p = self.parent(SVG.Pattern)

        if(p === null) return

        // ensure image size
        if (self.width() == 0 && self.height() == 0)
          self.size(img.width, img.height)

        // ensure pattern size if not set
        if (p && p.width() == 0 && p.height() == 0)
          p.size(self.width(), self.height())

        // callback
        if (typeof self._loaded === 'function')
          self._loaded.call(self, {
            width:  img.width
          , height: img.height
          , ratio:  img.width / img.height
          , url:    url
          })
      }

      img.onerror = function(e){
        if (typeof self._error === 'function'){
            self._error.call(self, e)
        }
      }

      return this.attr('href', (img.src = this.src = url), SVG.xlink)
    }
    // Add loaded callback
  , loaded: function(loaded) {
      this._loaded = loaded
      return this
    }

  , error: function(error) {
      this._error = error
      return this
    }
  }

  // Add parent method
, construct: {
    // create image element, load image and set its size
    image: function(source, width, height) {
      return this.put(new SVG.Image).load(source).size(width || 0, height || width || 0)
    }
  }

})
SVG.Text = SVG.invent({
  // Initialize node
  create: function() {
    this.constructor.call(this, SVG.create('text'))

    this.dom.leading = new SVG.Number(1.3)    // store leading value for rebuilding
    this._rebuild = true                      // enable automatic updating of dy values
    this._build   = false                     // disable build mode for adding multiple lines

    // set default font
    this.attr('font-family', SVG.defaults.attrs['font-family'])
  }

  // Inherit from
, inherit: SVG.Shape

  // Add class methods
, extend: {
    // Move over x-axis
    x: function(x) {
      // act as getter
      if (x == null)
        return this.attr('x')

      // move lines as well if no textPath is present
      if (!this.textPath)
        this.lines().each(function() { if (this.dom.newLined) this.x(x) })

      return this.attr('x', x)
    }
    // Move over y-axis
  , y: function(y) {
      var oy = this.attr('y')
        , o  = typeof oy === 'number' ? oy - this.bbox().y : 0

      // act as getter
      if (y == null)
        return typeof oy === 'number' ? oy - o : oy

      return this.attr('y', typeof y === 'number' ? y + o : y)
    }
    // Move center over x-axis
  , cx: function(x) {
      return x == null ? this.bbox().cx : this.x(x - this.bbox().width / 2)
    }
    // Move center over y-axis
  , cy: function(y) {
      return y == null ? this.bbox().cy : this.y(y - this.bbox().height / 2)
    }
    // Set the text content
  , text: function(text) {
      // act as getter
      if (typeof text === 'undefined'){
        var text = ''
        var children = this.node.childNodes
        for(var i = 0, len = children.length; i < len; ++i){

          // add newline if its not the first child and newLined is set to true
          if(i != 0 && children[i].nodeType != 3 && SVG.adopt(children[i]).dom.newLined == true){
            text += '\n'
          }

          // add content of this node
          text += children[i].textContent
        }

        return text
      }

      // remove existing content
      this.clear().build(true)

      if (typeof text === 'function') {
        // call block
        text.call(this, this)

      } else {
        // store text and make sure text is not blank
        text = text.split('\n')

        // build new lines
        for (var i = 0, il = text.length; i < il; i++)
          this.tspan(text[i]).newLine()
      }

      // disable build mode and rebuild lines
      return this.build(false).rebuild()
    }
    // Set font size
  , size: function(size) {
      return this.attr('font-size', size).rebuild()
    }
    // Set / get leading
  , leading: function(value) {
      // act as getter
      if (value == null)
        return this.dom.leading

      // act as setter
      this.dom.leading = new SVG.Number(value)

      return this.rebuild()
    }
    // Get all the first level lines
  , lines: function() {
      var node = (this.textPath && this.textPath() || this).node

      // filter tspans and map them to SVG.js instances
      var lines = SVG.utils.map(SVG.utils.filterSVGElements(node.childNodes), function(el){
        return SVG.adopt(el)
      })

      // return an instance of SVG.set
      return new SVG.Set(lines)
    }
    // Rebuild appearance type
  , rebuild: function(rebuild) {
      // store new rebuild flag if given
      if (typeof rebuild == 'boolean')
        this._rebuild = rebuild

      // define position of all lines
      if (this._rebuild) {
        var self = this
          , blankLineOffset = 0
          , dy = this.dom.leading * new SVG.Number(this.attr('font-size'))

        this.lines().each(function() {
          if (this.dom.newLined) {
            if (!this.textPath)
              this.attr('x', self.attr('x'))

            if(this.text() == '\n') {
              blankLineOffset += dy
            }else{
              this.attr('dy', dy + blankLineOffset)
              blankLineOffset = 0
            }
          }
        })

        this.fire('rebuild')
      }

      return this
    }
    // Enable / disable build mode
  , build: function(build) {
      this._build = !!build
      return this
    }
    // overwrite method from parent to set data properly
  , setData: function(o){
      this.dom = o
      this.dom.leading = new SVG.Number(o.leading || 1.3)
      return this
    }
  }

  // Add parent method
, construct: {
    // Create text element
    text: function(text) {
      return this.put(new SVG.Text).text(text)
    }
    // Create plain text element
  , plain: function(text) {
      return this.put(new SVG.Text).plain(text)
    }
  }

})

SVG.Tspan = SVG.invent({
  // Initialize node
  create: 'tspan'

  // Inherit from
, inherit: SVG.Shape

  // Add class methods
, extend: {
    // Set text content
    text: function(text) {
      if(text == null) return this.node.textContent + (this.dom.newLined ? '\n' : '')

      typeof text === 'function' ? text.call(this, this) : this.plain(text)

      return this
    }
    // Shortcut dx
  , dx: function(dx) {
      return this.attr('dx', dx)
    }
    // Shortcut dy
  , dy: function(dy) {
      return this.attr('dy', dy)
    }
    // Create new line
  , newLine: function() {
      // fetch text parent
      var t = this.parent(SVG.Text)

      // mark new line
      this.dom.newLined = true

      // apply new hy¡n
      return this.dy(t.dom.leading * t.attr('font-size')).attr('x', t.x())
    }
  }

})

SVG.extend(SVG.Text, SVG.Tspan, {
  // Create plain text node
  plain: function(text) {
    // clear if build mode is disabled
    if (this._build === false)
      this.clear()

    // create text node
    this.node.appendChild(document.createTextNode(text))

    return this
  }
  // Create a tspan
, tspan: function(text) {
    var node  = (this.textPath && this.textPath() || this).node
      , tspan = new SVG.Tspan

    // clear if build mode is disabled
    if (this._build === false)
      this.clear()

    // add new tspan
    node.appendChild(tspan.node)

    return tspan.text(text)
  }
  // Clear all lines
, clear: function() {
    var node = (this.textPath && this.textPath() || this).node

    // remove existing child nodes
    while (node.hasChildNodes())
      node.removeChild(node.lastChild)

    return this
  }
  // Get length of text element
, length: function() {
    return this.node.getComputedTextLength()
  }
})

SVG.TextPath = SVG.invent({
  // Initialize node
  create: 'textPath'

  // Inherit from
, inherit: SVG.Parent

  // Define parent class
, parent: SVG.Text

  // Add parent method
, construct: {
    // Create path for text to run on
    path: function(d) {
      // create textPath element
      var path  = new SVG.TextPath
        , track = this.doc().defs().path(d)

      // move lines to textpath
      while (this.node.hasChildNodes())
        path.node.appendChild(this.node.firstChild)

      // add textPath element as child node
      this.node.appendChild(path.node)

      // link textPath to path and add content
      path.attr('href', '#' + track, SVG.xlink)

      return this
    }
    // Plot path if any
  , plot: function(d) {
      var track = this.track()

      if (track)
        track.plot(d)

      return this
    }
    // Get the path track element
  , track: function() {
      var path = this.textPath()

      if (path)
        return path.reference('href')
    }
    // Get the textPath child
  , textPath: function() {
      if (this.node.firstChild && this.node.firstChild.nodeName == 'textPath')
        return SVG.adopt(this.node.firstChild)
    }
  }
})
SVG.Nested = SVG.invent({
  // Initialize node
  create: function() {
    this.constructor.call(this, SVG.create('svg'))

    this.style('overflow', 'visible')
  }

  // Inherit from
, inherit: SVG.Container

  // Add parent method
, construct: {
    // Create nested svg document
    nested: function() {
      return this.put(new SVG.Nested)
    }
  }
})
SVG.A = SVG.invent({
  // Initialize node
  create: 'a'

  // Inherit from
, inherit: SVG.Container

  // Add class methods
, extend: {
    // Link url
    to: function(url) {
      return this.attr('href', url, SVG.xlink)
    }
    // Link show attribute
  , show: function(target) {
      return this.attr('show', target, SVG.xlink)
    }
    // Link target attribute
  , target: function(target) {
      return this.attr('target', target)
    }
  }

  // Add parent method
, construct: {
    // Create a hyperlink element
    link: function(url) {
      return this.put(new SVG.A).to(url)
    }
  }
})

SVG.extend(SVG.Element, {
  // Create a hyperlink element
  linkTo: function(url) {
    var link = new SVG.A

    if (typeof url == 'function')
      url.call(link, link)
    else
      link.to(url)

    return this.parent().put(link).put(this)
  }

})
SVG.Marker = SVG.invent({
  // Initialize node
  create: 'marker'

  // Inherit from
, inherit: SVG.Container

  // Add class methods
, extend: {
    // Set width of element
    width: function(width) {
      return this.attr('markerWidth', width)
    }
    // Set height of element
  , height: function(height) {
      return this.attr('markerHeight', height)
    }
    // Set marker refX and refY
  , ref: function(x, y) {
      return this.attr('refX', x).attr('refY', y)
    }
    // Update marker
  , update: function(block) {
      // remove all content
      this.clear()

      // invoke passed block
      if (typeof block == 'function')
        block.call(this, this)

      return this
    }
    // Return the fill id
  , toString: function() {
      return 'url(#' + this.id() + ')'
    }
  }

  // Add parent method
, construct: {
    marker: function(width, height, block) {
      // Create marker element in defs
      return this.defs().marker(width, height, block)
    }
  }

})

SVG.extend(SVG.Defs, {
  // Create marker
  marker: function(width, height, block) {
    // Set default viewbox to match the width and height, set ref to cx and cy and set orient to auto
    return this.put(new SVG.Marker)
      .size(width, height)
      .ref(width / 2, height / 2)
      .viewbox(0, 0, width, height)
      .attr('orient', 'auto')
      .update(block)
  }

})

SVG.extend(SVG.Line, SVG.Polyline, SVG.Polygon, SVG.Path, {
  // Create and attach markers
  marker: function(marker, width, height, block) {
    var attr = ['marker']

    // Build attribute name
    if (marker != 'all') attr.push(marker)
    attr = attr.join('-')

    // Set marker attribute
    marker = arguments[1] instanceof SVG.Marker ?
      arguments[1] :
      this.doc().marker(width, height, block)

    return this.attr(attr, marker)
  }

})
// Define list of available attributes for stroke and fill
var sugar = {
  stroke: ['color', 'width', 'opacity', 'linecap', 'linejoin', 'miterlimit', 'dasharray', 'dashoffset']
, fill:   ['color', 'opacity', 'rule']
, prefix: function(t, a) {
    return a == 'color' ? t : t + '-' + a
  }
}

// Add sugar for fill and stroke
;['fill', 'stroke'].forEach(function(m) {
  var i, extension = {}

  extension[m] = function(o) {
    if (typeof o == 'undefined')
      return this
    if (typeof o == 'string' || SVG.Color.isRgb(o) || (o && typeof o.fill === 'function'))
      this.attr(m, o)

    else
      // set all attributes from sugar.fill and sugar.stroke list
      for (i = sugar[m].length - 1; i >= 0; i--)
        if (o[sugar[m][i]] != null)
          this.attr(sugar.prefix(m, sugar[m][i]), o[sugar[m][i]])

    return this
  }

  SVG.extend(SVG.Element, SVG.FX, extension)

})

SVG.extend(SVG.Element, SVG.FX, {
  // Map rotation to transform
  rotate: function(d, cx, cy) {
    return this.transform({ rotation: d, cx: cx, cy: cy })
  }
  // Map skew to transform
, skew: function(x, y, cx, cy) {
    return arguments.length == 1  || arguments.length == 3 ?
      this.transform({ skew: x, cx: y, cy: cx }) :
      this.transform({ skewX: x, skewY: y, cx: cx, cy: cy })
  }
  // Map scale to transform
, scale: function(x, y, cx, cy) {
    return arguments.length == 1  || arguments.length == 3 ?
      this.transform({ scale: x, cx: y, cy: cx }) :
      this.transform({ scaleX: x, scaleY: y, cx: cx, cy: cy })
  }
  // Map translate to transform
, translate: function(x, y) {
    return this.transform({ x: x, y: y })
  }
  // Map flip to transform
, flip: function(a, o) {
    return this.transform({ flip: a, offset: o })
  }
  // Map matrix to transform
, matrix: function(m) {
    return this.attr('transform', new SVG.Matrix(m))
  }
  // Opacity
, opacity: function(value) {
    return this.attr('opacity', value)
  }
  // Relative move over x axis
, dx: function(x) {
    return this.x((this instanceof SVG.FX ? 0 : this.x()) + x, true)
  }
  // Relative move over y axis
, dy: function(y) {
    return this.y((this instanceof SVG.FX ? 0 : this.y()) + y, true)
  }
  // Relative move over x and y axes
, dmove: function(x, y) {
    return this.dx(x).dy(y)
  }
})

SVG.extend(SVG.Rect, SVG.Ellipse, SVG.Circle, SVG.Gradient, SVG.FX, {
  // Add x and y radius
  radius: function(x, y) {
    var type = (this._target || this).type;
    return type == 'radial' || type == 'circle' ?
      this.attr('r', new SVG.Number(x)) :
      this.rx(x).ry(y == null ? x : y)
  }
})

SVG.extend(SVG.Path, {
  // Get path length
  length: function() {
    return this.node.getTotalLength()
  }
  // Get point at length
, pointAt: function(length) {
    return this.node.getPointAtLength(length)
  }
})

SVG.extend(SVG.Parent, SVG.Text, SVG.FX, {
  // Set font
  font: function(o) {
    for (var k in o)
      k == 'leading' ?
        this.leading(o[k]) :
      k == 'anchor' ?
        this.attr('text-anchor', o[k]) :
      k == 'size' || k == 'family' || k == 'weight' || k == 'stretch' || k == 'variant' || k == 'style' ?
        this.attr('font-'+ k, o[k]) :
        this.attr(k, o[k])

    return this
  }
})

SVG.Set = SVG.invent({
  // Initialize
  create: function(members) {
    // Set initial state
    Array.isArray(members) ? this.members = members : this.clear()
  }

  // Add class methods
, extend: {
    // Add element to set
    add: function() {
      var i, il, elements = [].slice.call(arguments)

      for (i = 0, il = elements.length; i < il; i++)
        this.members.push(elements[i])

      return this
    }
    // Remove element from set
  , remove: function(element) {
      var i = this.index(element)

      // remove given child
      if (i > -1)
        this.members.splice(i, 1)

      return this
    }
    // Iterate over all members
  , each: function(block) {
      for (var i = 0, il = this.members.length; i < il; i++)
        block.apply(this.members[i], [i, this.members])

      return this
    }
    // Restore to defaults
  , clear: function() {
      // initialize store
      this.members = []

      return this
    }
    // Get the length of a set
  , length: function() {
      return this.members.length
    }
    // Checks if a given element is present in set
  , has: function(element) {
      return this.index(element) >= 0
    }
    // retuns index of given element in set
  , index: function(element) {
      return this.members.indexOf(element)
    }
    // Get member at given index
  , get: function(i) {
      return this.members[i]
    }
    // Get first member
  , first: function() {
      return this.get(0)
    }
    // Get last member
  , last: function() {
      return this.get(this.members.length - 1)
    }
    // Default value
  , valueOf: function() {
      return this.members
    }
    // Get the bounding box of all members included or empty box if set has no items
  , bbox: function(){
      var box = new SVG.BBox()

      // return an empty box of there are no members
      if (this.members.length == 0)
        return box

      // get the first rbox and update the target bbox
      var rbox = this.members[0].rbox()
      box.x      = rbox.x
      box.y      = rbox.y
      box.width  = rbox.width
      box.height = rbox.height

      this.each(function() {
        // user rbox for correct position and visual representation
        box = box.merge(this.rbox())
      })

      return box
    }
  }

  // Add parent method
, construct: {
    // Create a new set
    set: function(members) {
      return new SVG.Set(members)
    }
  }
})

SVG.FX.Set = SVG.invent({
  // Initialize node
  create: function(set) {
    // store reference to set
    this.set = set
  }

})

// Alias methods
SVG.Set.inherit = function() {
  var m
    , methods = []

  // gather shape methods
  for(var m in SVG.Shape.prototype)
    if (typeof SVG.Shape.prototype[m] == 'function' && typeof SVG.Set.prototype[m] != 'function')
      methods.push(m)

  // apply shape aliasses
  methods.forEach(function(method) {
    SVG.Set.prototype[method] = function() {
      for (var i = 0, il = this.members.length; i < il; i++)
        if (this.members[i] && typeof this.members[i][method] == 'function')
          this.members[i][method].apply(this.members[i], arguments)

      return method == 'animate' ? (this.fx || (this.fx = new SVG.FX.Set(this))) : this
    }
  })

  // clear methods for the next round
  methods = []

  // gather fx methods
  for(var m in SVG.FX.prototype)
    if (typeof SVG.FX.prototype[m] == 'function' && typeof SVG.FX.Set.prototype[m] != 'function')
      methods.push(m)

  // apply fx aliasses
  methods.forEach(function(method) {
    SVG.FX.Set.prototype[method] = function() {
      for (var i = 0, il = this.set.members.length; i < il; i++)
        this.set.members[i].fx[method].apply(this.set.members[i].fx, arguments)

      return this
    }
  })
}




SVG.extend(SVG.Element, {
  // Store data values on svg nodes
  data: function(a, v, r) {
    if (typeof a == 'object') {
      for (v in a)
        this.data(v, a[v])

    } else if (arguments.length < 2) {
      try {
        return JSON.parse(this.attr('data-' + a))
      } catch(e) {
        return this.attr('data-' + a)
      }

    } else {
      this.attr(
        'data-' + a
      , v === null ?
          null :
        r === true || typeof v === 'string' || typeof v === 'number' ?
          v :
          JSON.stringify(v)
      )
    }

    return this
  }
})
SVG.extend(SVG.Element, {
  // Remember arbitrary data
  remember: function(k, v) {
    // remember every item in an object individually
    if (typeof arguments[0] == 'object')
      for (var v in k)
        this.remember(v, k[v])

    // retrieve memory
    else if (arguments.length == 1)
      return this.memory()[k]

    // store memory
    else
      this.memory()[k] = v

    return this
  }

  // Erase a given memory
, forget: function() {
    if (arguments.length == 0)
      this._memory = {}
    else
      for (var i = arguments.length - 1; i >= 0; i--)
        delete this.memory()[arguments[i]]

    return this
  }

  // Initialize or return local memory object
, memory: function() {
    return this._memory || (this._memory = {})
  }

})
// Method for getting an element by id
SVG.get = function(id) {
  var node = document.getElementById(idFromReference(id) || id)
  return SVG.adopt(node)
}

// Select elements by query string
SVG.select = function(query, parent) {
  return new SVG.Set(
    SVG.utils.map((parent || document).querySelectorAll(query), function(node) {
      return SVG.adopt(node)
    })
  )
}

SVG.extend(SVG.Parent, {
  // Scoped select method
  select: function(query) {
    return SVG.select(query, this.node)
  }

})
function is(el, obj){
  return el instanceof obj
}

// tests if a given selector matches an element
function matches(el, selector) {
  return (el.matches || el.matchesSelector || el.msMatchesSelector || el.mozMatchesSelector || el.webkitMatchesSelector || el.oMatchesSelector).call(el, selector);
}

// Convert dash-separated-string to camelCase
function camelCase(s) {
  return s.toLowerCase().replace(/-(.)/g, function(m, g) {
    return g.toUpperCase()
  })
}

// Capitalize first letter of a string
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Ensure to six-based hex
function fullHex(hex) {
  return hex.length == 4 ?
    [ '#',
      hex.substring(1, 2), hex.substring(1, 2)
    , hex.substring(2, 3), hex.substring(2, 3)
    , hex.substring(3, 4), hex.substring(3, 4)
    ].join('') : hex
}

// Component to hex value
function compToHex(comp) {
  var hex = comp.toString(16)
  return hex.length == 1 ? '0' + hex : hex
}

// Calculate proportional width and height values when necessary
function proportionalSize(element, width, height) {
  if (width == null || height == null) {
    var box = element.bbox()

    if (width == null)
      width = box.width / box.height * height
    else if (height == null)
      height = box.height / box.width * width
  }

  return {
    width:  width
  , height: height
  }
}

// Delta transform point
function deltaTransformPoint(matrix, x, y) {
  return {
    x: x * matrix.a + y * matrix.c + 0
  , y: x * matrix.b + y * matrix.d + 0
  }
}

// Map matrix array to object
function arrayToMatrix(a) {
  return { a: a[0], b: a[1], c: a[2], d: a[3], e: a[4], f: a[5] }
}

// Parse matrix if required
function parseMatrix(matrix) {
  if (!(matrix instanceof SVG.Matrix))
    matrix = new SVG.Matrix(matrix)

  return matrix
}

// Add centre point to transform object
function ensureCentre(o, target) {
  o.cx = o.cx == null ? target.bbox().cx : o.cx
  o.cy = o.cy == null ? target.bbox().cy : o.cy
}

// Convert string to matrix
function stringToMatrix(source) {
  // remove matrix wrapper and split to individual numbers
  source = source
    .replace(SVG.regex.whitespace, '')
    .replace(SVG.regex.matrix, '')
    .split(SVG.regex.matrixElements)

  // convert string values to floats and convert to a matrix-formatted object
  return arrayToMatrix(
    SVG.utils.map(source, function(n) {
      return parseFloat(n)
    })
  )
}

// Calculate position according to from and to
function at(o, pos) {
  // number recalculation (don't bother converting to SVG.Number for performance reasons)
  return typeof o.from == 'number' ?
    o.from + (o.to - o.from) * pos :

  // instance recalculation
  o instanceof SVG.Color || o instanceof SVG.Number || o instanceof SVG.Matrix ? o.at(pos) :

  // for all other values wait until pos has reached 1 to return the final value
  pos < 1 ? o.from : o.to
}

// PathArray Helpers
function arrayToString(a) {
  for (var i = 0, il = a.length, s = ''; i < il; i++) {
    s += a[i][0]

    if (a[i][1] != null) {
      s += a[i][1]

      if (a[i][2] != null) {
        s += ' '
        s += a[i][2]

        if (a[i][3] != null) {
          s += ' '
          s += a[i][3]
          s += ' '
          s += a[i][4]

          if (a[i][5] != null) {
            s += ' '
            s += a[i][5]
            s += ' '
            s += a[i][6]

            if (a[i][7] != null) {
              s += ' '
              s += a[i][7]
            }
          }
        }
      }
    }
  }

  return s + ' '
}

// Deep new id assignment
function assignNewId(node) {
  // do the same for SVG child nodes as well
  for (var i = node.childNodes.length - 1; i >= 0; i--)
    if (node.childNodes[i] instanceof SVGElement)
      assignNewId(node.childNodes[i])

  return SVG.adopt(node).id(SVG.eid(node.nodeName))
}

// Add more bounding box properties
function fullBox(b) {
  if (b.x == null) {
    b.x      = 0
    b.y      = 0
    b.width  = 0
    b.height = 0
  }

  b.w  = b.width
  b.h  = b.height
  b.x2 = b.x + b.width
  b.y2 = b.y + b.height
  b.cx = b.x + b.width / 2
  b.cy = b.y + b.height / 2

  return b
}

// Get id from reference string
function idFromReference(url) {
  var m = url.toString().match(SVG.regex.reference)

  if (m) return m[1]
}

// Create matrix array for looping
var abcdef = 'abcdef'.split('')
// Add CustomEvent to IE9 and IE10
if (typeof CustomEvent !== 'function') {
  // Code from: https://developer.mozilla.org/en-US/docs/Web/API/CustomEvent
  var CustomEvent = function(event, options) {
    options = options || { bubbles: false, cancelable: false, detail: undefined }
    var e = document.createEvent('CustomEvent')
    e.initCustomEvent(event, options.bubbles, options.cancelable, options.detail)
    return e
  }

  CustomEvent.prototype = window.Event.prototype

  window.CustomEvent = CustomEvent
}

// requestAnimationFrame / cancelAnimationFrame Polyfill with fallback based on Paul Irish
(function(w) {
  var lastTime = 0
  var vendors = ['moz', 'webkit']

  for(var x = 0; x < vendors.length && !window.requestAnimationFrame; ++x) {
    w.requestAnimationFrame = w[vendors[x] + 'RequestAnimationFrame']
    w.cancelAnimationFrame  = w[vendors[x] + 'CancelAnimationFrame'] ||
                              w[vendors[x] + 'CancelRequestAnimationFrame']
  }

  w.requestAnimationFrame = w.requestAnimationFrame ||
    function(callback) {
      var currTime = new Date().getTime()
      var timeToCall = Math.max(0, 16 - (currTime - lastTime))

      var id = w.setTimeout(function() {
        callback(currTime + timeToCall)
      }, timeToCall)

      lastTime = currTime + timeToCall
      return id
    }

  w.cancelAnimationFrame = w.cancelAnimationFrame || w.clearTimeout;

}(window))

return SVG

}));
},{}],12:[function(require,module,exports){
'use strict';

module.exports = TinyQueue;

function TinyQueue(data, compare) {
    if (!(this instanceof TinyQueue)) return new TinyQueue(data, compare);

    this.data = data || [];
    this.length = this.data.length;
    this.compare = compare || defaultCompare;

    if (this.length > 0) {
        for (var i = (this.length >> 1); i >= 0; i--) this._down(i);
    }
}

function defaultCompare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

TinyQueue.prototype = {

    push: function (item) {
        this.data.push(item);
        this.length++;
        this._up(this.length - 1);
    },

    pop: function () {
        if (this.length === 0) return undefined;
        var top = this.data[0];
        this.length--;
        if (this.length > 0) {
            this.data[0] = this.data[this.length];
            this._down(0);
        }
        this.data.pop();
        return top;
    },

    peek: function () {
        return this.data[0];
    },

    _up: function (pos) {
        var data = this.data;
        var compare = this.compare;
        var item = data[pos];

        while (pos > 0) {
            var parent = (pos - 1) >> 1;
            var current = data[parent];
            if (compare(item, current) >= 0) break;
            data[pos] = current;
            pos = parent;
        }

        data[pos] = item;
    },

    _down: function (pos) {
        var data = this.data;
        var compare = this.compare;
        var len = this.length;
        var halfLen = len >> 1;
        var item = data[pos];

        while (pos < halfLen) {
            var left = (pos << 1) + 1;
            var right = left + 1;
            var best = data[left];

            if (right < len && compare(data[right], best) < 0) {
                left = right;
                best = data[right];
            }
            if (compare(best, item) >= 0) break;

            data[pos] = best;
            pos = left;
        }

        data[pos] = item;
    }
};

},{}],13:[function(require,module,exports){
"use strict"

module.exports = twoProduct

var SPLITTER = +(Math.pow(2, 27) + 1.0)

function twoProduct(a, b, result) {
  var x = a * b

  var c = SPLITTER * a
  var abig = c - a
  var ahi = c - abig
  var alo = a - ahi

  var d = SPLITTER * b
  var bbig = d - b
  var bhi = d - bbig
  var blo = b - bhi

  var err1 = x - (ahi * bhi)
  var err2 = err1 - (alo * bhi)
  var err3 = err2 - (ahi * blo)

  var y = alo * blo - err3

  if(result) {
    result[0] = y
    result[1] = x
    return result
  }

  return [ y, x ]
}
},{}],14:[function(require,module,exports){
"use strict"

module.exports = fastTwoSum

function fastTwoSum(a, b, result) {
	var x = a + b
	var bv = x - a
	var av = x - bv
	var br = b - bv
	var ar = a - av
	if(result) {
		result[0] = ar + br
		result[1] = x
		return result
	}
	return [ar+br, x]
}
},{}],15:[function(require,module,exports){
'use strict';

Object.defineProperty(exports, "__esModule", {
	value: true
});
var leaf1 = require('../images/leaf1.svg');
var leaf2 = require('../images/leaf2.svg');
var leaf3 = require('../images/leaf3.svg');
var leaf4 = require('../images/leaf4.svg');
var leaf5 = require('../images/leaf5.svg');
var leaf6 = require('../images/leaf6.svg');
var cap = exports.cap = require('../images/sideFlower_v6.svg');

var LeafImage = exports.LeafImage = [leaf1, leaf2, leaf3, leaf4, leaf5, leaf6];

var leafBranch1 = require('./leaf_branch/1.svg');
var leafBranch2 = require('./leaf_branch/2.svg');
var leafBranch3 = require('./leaf_branch/3.svg');
var leafBranch4 = require('./leaf_branch/4.svg');
var leafBranch5 = require('./leaf_branch/5.svg');
var leafBranch6 = require('./leaf_branch/6.svg');
var leafBranch7 = require('./leaf_branch/7.svg');

var LeafBranch = exports.LeafBranch = [leafBranch1, leafBranch2, leafBranch3, leafBranch4, leafBranch5, leafBranch6, leafBranch7];

var leafType = exports.leafType = {
	leaf: Symbol(),
	leafBranch: Symbol()
};

var flowerString = exports.flowerString = require('../images/海石榴心_v3.svg');

var leafColliders = exports.leafColliders = [[[0.641, 20.975], [-0.7910000000000004, 33.213], [5.211, 52.685], [29.637, 87.203], [39.449, 97.453], [52.277, 107.498], [55.494, 107.644], [63.062, 72.24000000000001], [66.777, 59.51800000000001], [69.576, 40.55000000000001], [65.773, 26.878000000000007], [63.024, 16.996], [55.58, 7.944], [46.094, 3.91], [41.104, 1.7880000000000003], [33.351, -0.1559999999999997], [18.631, 2.188], [10.542, 6.17], [5.35, 13.933], [0.641, 20.975]], [[3.048, 2.366], [0.1, 16.335], [0.795, 28.369], [6.428999999999999, 68.307], [34.568000000000005, 67.074], [65.027, 65.741], [72.028, 38.022999999999996], [72.26500000000001, 30.373999999999995], [72.66700000000002, 17.348999999999997], [65.80600000000001, 12.953999999999994], [43.592, 1.138], [37.325, 0.53], [31.059, -0.077], [3.048, 2.366]], [[0.74, 30.759], [-0.548, 40.765], [3.21, 59.829], [15.218, 65.549], [25.158, 59.31300000000001], [31.42, 45.275000000000006], [31.983999999999998, 33.483000000000004], [32.592, 20.724000000000004], [25.551, 7.5290000000000035], [13.273999999999997, 0.6020000000000039], [7.237, 5.436], [2.565, 16.587], [0.74, 30.759]], [[0.817, 47.522000000000006], [-0.6949999999999998, 56.14500000000001], [0.746, 92.994], [17.82, 105.23400000000001], [24.935, 108.863], [32.888, 105.787], [49.317, 99.431], [68.53, 86.11], [70.09299999999999, 66.373], [70.908, 56.051], [68.901, 50.21600000000001], [59.263999999999996, 25.712], [55.985, 17.451], [49.846, 1.989], [22.766, -1.906], [2.851, 35.932], [0.817, 47.522000000000006]], [[-3.394000000000016, 15.081], [-3.7570000000000157, 53.028999999999996], [12.617999999999984, 68.605], [34.335999999999984, 88.689], [42.82799999999999, 88.69], [55.43199999999999, 88.691], [61.30899999999999, 84.767], [81.68199999999999, 64.367], [83.18199999999999, 61.223], [84.43199999999999, 57.069], [86.32, 50.793], [86.432, 38.883], [78.387, 16.162], [71.95299999999999, 9.367], [64.27499999999999, 1.2620000000000005], [55.13199999999999, 0.32700000000000173], [43.74499999999999, 0.5210000000000008], [38.67299999999999, 0.6080000000000008], [34.01899999999999, 1.7710000000000008], [-3.394000000000016, 15.081]], [[24.687, 8.368000000000002], [22.881, 12.819], [11.317000000000004, 44.86200000000001], [4.337000000000004, 55.91000000000001], [-2.347999999999996, 67.86900000000001], [1.7560000000000042, 79.71300000000001], [2.430000000000004, 81.65700000000001], [3.3640000000000043, 83.659], [15.108000000000008, 97.641], [17.331000000000007, 99.18400000000001], [27.76200000000001, 105.03599999999999], [31.52200000000001, 107.04800000000002], [48.47300000000001, 108.165], [62.35900000000001, 101.78800000000001], [74.864, 96.046], [82.87400000000001, 79.679], [80.87, 68.974], [122.69500000000001, 54.682], [138.80100000000002, 49.358000000000004], [148.836, 54.682], [162.637, 53.11600000000001], [169.359, 53.589000000000006], [174.843, 58.424], [187.20600000000002, 59.778999999999996], [192.649, 64.506], [205.304, 74.822], [212.66500000000002, 68.55799999999999], [178.531, 52.903999999999996], [164.747, 43.137], [144.316, 28.657], [132.724, 15.283999999999997], [118.358, 8.466999999999997], [104.989, 2.1239999999999966], [91.019, -1.9590000000000032], [64.543, 2.1629999999999967], [24.687, 8.368000000000002]]];

},{"../images/leaf1.svg":16,"../images/leaf2.svg":17,"../images/leaf3.svg":18,"../images/leaf4.svg":19,"../images/leaf5.svg":20,"../images/leaf6.svg":21,"../images/sideFlower_v6.svg":29,"../images/海石榴心_v3.svg":30,"./leaf_branch/1.svg":22,"./leaf_branch/2.svg":23,"./leaf_branch/3.svg":24,"./leaf_branch/4.svg":25,"./leaf_branch/5.svg":26,"./leaf_branch/6.svg":27,"./leaf_branch/7.svg":28}],16:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\r\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\r\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\r\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\r\n\t y=\"0px\" width=\"68.718px\" height=\"107.998px\" viewBox=\"0 0 68.718 107.998\" style=\"enable-background:new 0 0 68.718 107.998;\"\r\n\t xml:space=\"preserve\">\r\n<g>\r\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M52.277,107.498c3.217,0.146,9.744-31.692,10.785-35.258\r\n\t\tc3.715-12.722,6.514-31.69,2.711-45.362C63.024,16.996,55.58,7.944,46.094,3.91c-4.99-2.122-12.743-4.066-18.196-3.197\r\n\t\tC18.631,2.188,10.542,6.17,5.35,13.933c-4.709,7.042-6.141,19.28-3.625,27.44c3.486,11.312,16.256,17.618,26.683,16.68\r\n\t\tc3.862-0.348,9.786-1.644,12.821-6.488c2.389-3.814,4.777-11.461,3.969-16.008c1.319,0.56-0.01,6.754-0.381,8.396\r\n\t\tc-0.82,3.628-3.852,7.539-4.43,10.583c-1.14,5.995-10.75,32.667-0.938,42.917L52.277,107.498z\"/>\r\n\t<path style=\"fill:#94A4CF;\" d=\"M42.163,94.498c-6.392-7.114-1.233-26.293,0.979-34.524c0.537-1.994,5.047-12.802,5.575-15.139\r\n\t\tc1.267-5.601-2.655-15.595-6.322-13.428c-5.237,3.095-0.703,4.592-0.189,7.08c0.592,3.33-2.333,7.708-4.367,10.956\r\n\t\tc-2.056,3.281-6.458,4.327-9.79,4.627c-0.558,0.051-1.135,0.076-1.715,0.076c-7.993,0-17.994-4.889-20.787-13.949\r\n\t\tc-2.215-7.184-0.783-18.191,3.127-24.039C12.814,9.968,19.493,6.101,28.527,4.663C29.204,4.555,29.972,4.5,30.81,4.5\r\n\t\tc4.762,0,10.366,1.664,13.717,3.09c8.082,3.437,16.195,10.712,19.025,19.54c5.165,16.109-0.99,40.943-5.666,56.667\r\n\t\tc-1.575,5.296-4.561,15.602-6.051,20.506L42.163,94.498z\"/>\r\n\t<path style=\"fill:#5E5264;\" d=\"M28.58,36.492c-4.227,1.481-7.185-0.918-8.685-6.752c-1.433-5.573,0.667-10.167,5.5-13.833\r\n\t\tc2.878-2.184,8.647-3,12.854-1.69c6.714,2.09,11.917,9.148,14.146,14.023c1.969,4.305,1.853,11.669,1.833,15.667\r\n\t\tc-0.031,6.302-12.083,29.833-14.471,31.912c0.054-6.579,2.734-13.303,3.385-15.846c0.936-3.658,6.486-14.111,5.771-18.68\r\n\t\tc-1.24-7.931-5.2-14.068-10.519-17.886c-3.119-2.239-8.167-1.833-8.667,1C29.166,27.593,35.008,34.24,28.58,36.492z\"/>\r\n</g>\r\n<line id=\"direct\" style=\"display:none;fill:#FF0000;stroke:#FF0000;stroke-miterlimit:10;\" x1=\"52.277\" y1=\"107.498\" x2=\"15.972\" y2=\"4.5\"/>\r\n<polygon id=\"collider\" style=\"display:none;\" points=\"0.641,20.975 -0.7910000000000004,33.213 5.211,52.685 29.637,87.203 39.449,97.453 52.277,107.498 55.494,107.644 63.062,72.24000000000001 66.777,59.51800000000001 69.576,40.55000000000001 65.773,26.878000000000007 63.024,16.996 55.58,7.944 46.094,3.91 41.104,1.7880000000000003 33.351,-0.1559999999999997 18.631,2.188 10.542,6.17 5.35,13.933 0.641,20.975\" fill=\"none\" stroke=\"red\" stroke-width=\"3\"></polygon>\r\n</svg>\r\n";

},{}],17:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\r\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\r\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\r\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\r\n\t y=\"0px\" width=\"72.781px\" height=\"67.603px\" viewBox=\"0 0 72.781 67.603\" style=\"enable-background:new 0 0 72.781 67.603;\"\r\n\t xml:space=\"preserve\">\r\n<g>\r\n\t<path style=\"fill:#F7F5F1;stroke:#000000;stroke-miterlimit:10;\" d=\"M24.788,8.627c0,0-3.522-6.525-9.523-6.503\r\n\t\tC3.048,2.366,0.1,16.335,0.542,23.188c0.253,5.181,5.887,45.119,34.026,43.886c30.459-1.333,37.46-29.051,37.697-36.7\r\n\t\tc0.402-13.025-6.459-17.42-9.777-19.016c-6.563-3.155-13.737-1.37-13.737-1.37S43.592,1.138,37.325,0.53\r\n\t\tC31.059-0.077,24.788,8.627,24.788,8.627z\"/>\r\n\t<path style=\"fill:#ACBCBD;\" d=\"M25.209,14.456c0.007-1.532,2.591-6.832,11.731-6.548c6.158,0.191,8.569,6.584,8.569,6.584\r\n\t\ts3.804-0.91,4.66-0.919c1.808-0.018,3.304,0.351,4.938,0.982c3.224,1.243,6.064,2.851,7.569,6.131\r\n\t\tc2.193,4.786,2.497,3.092,1.665,9.362c-0.229,1.735-5.127,16.162-7.226,19.125c-1.763,2.484-10.127,10.342-15.649,11.409\r\n\t\tc-3.105,0.602-6.634,0.773-9.823,0.033c-3.287-0.763-12.442-6.214-16.24-10.254c-3.001-3.194-4.49-5.408-5.813-9.282\r\n\t\tc-1.079-3.153-3.319-9.971-3.412-13.349c-0.057-2.063-0.105-12.165,1.514-14.745c1.729-2.755,5.235-4.202,8.472-3.776\r\n\t\tC17.535,9.391,22.721,11.276,25.209,14.456z\"/>\r\n\t<path style=\"fill:#778581;\" d=\"M28.507,24.696c1.288-0.885,2.726-1.534,4.048-1.833c2.001-0.452,4.975,0.008,6.934,0.548\r\n\t\tc1.929,0.529,3.592,1.578,4.977,3.01c2.605,2.693,4.612,6.346,5.621,9.946c1.127,4.009,2.118,10.345,0.014,14.189\r\n\t\tc-2.375,4.345-6.973,7.697-12.009,7.552c-3.328-0.095-8.229-1.546-10.341-3.954c-3.323-3.787-4.733-9.248-4.855-14.544\r\n\t\tc-0.077-3.374,0.763-7.522,1.979-10.68C25.501,27.297,26.885,25.811,28.507,24.696z\"/>\r\n</g>\r\n<line id=\"direct\" style=\"display:none;fill:none;stroke:#FF0000;stroke-miterlimit:10;\" x2=\"37.325\" y2=\"0.53\" x1=\"34.567\" y1=\"67.074\"/>\r\n<polygon id=\"collider\" style=\"display:none;\" points=\"3.048,2.366 0.1,16.335 0.795,28.369 6.428999999999999,68.307 34.568000000000005,67.074 65.027,65.741 72.028,38.022999999999996 72.26500000000001,30.373999999999995 72.66700000000002,17.348999999999997 65.80600000000001,12.953999999999994 43.592,1.138 37.325,0.53 31.059,-0.077 3.048,2.366\" fill=\"none\" stroke=\"red\" stroke-width=\"3\"></polygon>\r\n</svg>\r\n";

},{}],18:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\r\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\r\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\r\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\r\n\t y=\"0px\" width=\"32.52px\" height=\"66.119px\" viewBox=\"0 0 32.52 66.119\" style=\"enable-background:new 0 0 32.52 66.119;\"\r\n\t xml:space=\"preserve\">\r\n<g>\r\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M0.74,30.759c-1.288,10.006,2.47,29.07,14.478,34.79\r\n\t\tc9.94-6.236,16.202-20.274,16.766-32.066c0.608-12.759-6.433-25.954-18.71-32.881C7.237,5.436,2.565,16.587,0.74,30.759z\"/>\r\n\t<path style=\"fill:#ABB8AD;\" d=\"M14.664,61.457C3.252,51.04,5.151,34.41,5.376,31.929C6.442,20.206,11.25,9.922,14.449,5.44\r\n\t\tc7.721,6.185,13.805,19.679,12.564,29.284C25.395,47.267,20.297,56.269,14.664,61.457z\"/>\r\n\t<path style=\"fill:#73776C;\" d=\"M14.922,59.597c6.154-6.572,2.618-33.078,0.38-35.587C7.721,29.267,10.493,56.648,14.922,59.597z\"/>\r\n</g>\r\n<line id=\"direct\" style=\"display:none;fill:none;stroke:#FF0000;stroke-miterlimit:10;\" x2=\"13.273\" y2=\"0.602\" x1=\"15.218\" y1=\"65.549\"/>\r\n<polygon id=\"collider\" style=\"display:none;\" points=\"0.74,30.759 -0.548,40.765 3.21,59.829 15.218,65.549 25.158,59.31300000000001 31.42,45.275000000000006 31.983999999999998,33.483000000000004 32.592,20.724000000000004 25.551,7.5290000000000035 13.273999999999997,0.6020000000000039 7.237,5.436 2.565,16.587 0.74,30.759\" fill=\"none\" stroke=\"red\" stroke-width=\"3\"></polygon>\r\n</svg>\r\n";

},{}],19:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\r\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\r\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\r\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\r\n\t y=\"0px\" width=\"70.77px\" height=\"107.416px\" viewBox=\"0 0 70.77 107.416\" style=\"enable-background:new 0 0 70.77 107.416;\"\r\n\t xml:space=\"preserve\">\r\n<g>\r\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M55.985,17.451c3.279,8.261,4.142,16.724,8.148,24.05\r\n\t\tc4.768,8.715,6.775,14.55,5.96,24.872C68.53,86.11,49.317,99.431,32.888,105.787c-7.953,3.076-15.068-0.553-22.437-5.836\r\n\t\tC0.746,92.994,1.635,85.355,2.77,75.293c0.978-8.677-3.465-19.148-1.953-27.771c2.034-11.59,6.927-16.38,14.784-22.73\r\n\t\tc6.887-5.567,9.948-14.217,7.992-22.987C22.766-1.906,49.846,1.989,55.985,17.451z\"/>\r\n\t<path style=\"fill:#ABB8AD;\" d=\"M66.063,66.54c-2.055,21.321-27.018,32.575-34.619,35.516c-6.053,2.343-11.628-0.313-18.662-5.354\r\n\t\tC6.301,92.055,5.563,87.58,6.36,79.31c0.109-1.13,0.24-2.291,0.375-3.486l0.051-0.481c0.439-4.563-0.359-9.318-1.131-13.917\r\n\t\tc-0.725-4.316-1.41-8.394-1.064-11.978c0.04-0.416,0.094-0.827,0.166-1.234c1.753-9.991,5.6-14.039,13.358-20.31\r\n\t\tc5.714-4.62,9.243-11.116,9.934-18.292c0.163-1.687,0.166-3.389,0.01-5.092c6.086,0.495,20.342,4.67,24.207,14.406\r\n\t\tc1.285,3.238,2.211,6.636,3.104,9.922c1.323,4.862,2.691,9.889,5.253,14.572c4.394,8.032,6.229,13.206,5.481,22.637L66.063,66.54z\"\r\n\t\t/>\r\n\t<path style=\"fill:#73776C;\" d=\"M33.044,42.863c0.906-1.608,2.051-2.96,3.016-4.539c0.638-1.044,3.75-2.75,3.75-2.75\r\n\t\ts2.512,3.206,3.146,4.519c1.715,3.546,4.101,7.457,4.528,11.403c0.253,2.325-0.603,4.681-1.015,6.922\r\n\t\tc-0.467,2.545-1.664,5.1-2.804,7.396c-2.553,5.146-6.769,10.214-13.073,9.304c-6.789-0.978-6.375-10.659-5.07-15.547\r\n\t\tc0.596-2.231,1.456-4.875,2.436-6.862C28.657,51.296,32.432,43.951,33.044,42.863z\"/>\r\n</g>\r\n<line id=\"direct\" style=\"display:none;fill:none;stroke:#FF0000;stroke-miterlimit:10;\" x2=\"23.593\" y2=\"1.805\" x1=\"43.414\" y1=\"100.863\"/>\r\n<polygon id=\"collider\" style=\"display:none;\" points=\"0.817,47.522000000000006 -0.6949999999999998,56.14500000000001 0.746,92.994 17.82,105.23400000000001 24.935,108.863 32.888,105.787 49.317,99.431 68.53,86.11 70.09299999999999,66.373 70.908,56.051 68.901,50.21600000000001 59.263999999999996,25.712 55.985,17.451 49.846,1.989 22.766,-1.906 2.851,35.932 0.817,47.522000000000006\" fill=\"none\" stroke=\"red\" stroke-width=\"3\"></polygon>\r\n</svg>\r\n";

},{}],20:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\r\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\r\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\r\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\r\n\t y=\"0px\" width=\"85.857px\" height=\"89.192px\" viewBox=\"0 0 85.857 89.192\" style=\"enable-background:new 0 0 85.857 89.192;\"\r\n\t xml:space=\"preserve\">\r\n<g>\r\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M73.708,33.057l-0.007-0.002\r\n\t\tc4.19-7.46,4.686-16.893-1.748-23.688c-7.678-8.105-16.821-9.04-28.208-8.846c-5.072,0.087-9.726,1.25-13.688,4.479\r\n\t\tc-4.519,3.686-5.338,9.812-8.874,14.459c-24.577-4.378-24.94,33.57-13.099,44.833c4.534,4.313,9.884,5.174,15.525,7.154\r\n\t\tc1.517,7.825,10.727,17.243,19.219,17.244c12.604,0.001,18.481-3.923,22.604-10.476c1.072-1.705,2.095-10.145,3.375-10.479\r\n\t\tc12.875-3.368,14.375-6.512,15.625-10.666C86.32,50.793,86.432,38.883,73.708,33.057z\"/>\r\n\t<path style=\"fill:#D9E0D1;\" d=\"M41.651,27.872c-1.682,0.602-1.813,3.184-2.09,4.656c-0.44,2.345,0.344,3.913,2.143,5.583\r\n\t\tc2.824,2.627,7.164,2.471,10.87,2.436c4.024-0.042,7.403-0.396,10.688-2.613c3.189-2.153,6.065-6.642,7.249-10.103\r\n\t\tc1.347-3.934,1.17-7.668,0.035-11.524c-1.317-4.466-3.973-7.479-8.318-9.71c-4.1-2.106-8.659-2.347-13.332-2.923\r\n\t\tc-4.946-0.61-9.182,0.132-13.686,1.979c-4.114,1.688-5.739,5.791-7.442,9.343c-0.876,1.826-2.723,6.926-4.539,7.788\r\n\t\tc-2.005,0.95-6.147,0.001-8.238,0.809c-4.31,1.666-11.066,7.587-11.56,17.473c-0.224,4.439,0.471,8.344,2.222,12.437\r\n\t\tc1.609,3.761,4.018,8.603,8.269,10.052c1.899,0.646,3.906,1.3,5.716,2.229c1.53,0.786,4.279,1.342,5.247,2.538\r\n\t\tc0.737,0.918,0.458,2.498,0.916,3.586c2.989,7.14,11.144,13.706,19.649,14.029c4.222,0.157,8.647-0.751,12.274-2.762\r\n\t\tc3.322-1.844,6.517-11.777,8.026-15.285c2.515-5.842,13.697-3.449,16.348-11.979c2-6.438-1.334-14.97-4.5-16.617\r\n\t\tc-3.113-1.619-8.333-2.695-11.263,0.035c-4.586,4.272-12.387,5.375-14.256,5.379c-9.806,0.026-17.278-4.749-18.123-7.093\r\n\t\tc-0.734-2.042-0.282-3.414,0.527-5.415c1.147-2.825,1.903-4.446,5.126-5.6c1.751-0.629,4.583,0.064,1.764,1.248\"/>\r\n\t<path style=\"fill:#9CB098;\" d=\"M39.61,26.601c-4.616,0.437-9.326,2.133-11.903,11.375c-1.294,4.648-1.561,8.946,0.634,13.439\r\n\t\tc2.465,5.045,6.436,9.27,11.457,12.16c3.606,2.077,8.577,3.539,12.695,1.705c12.772-0.537,9.982-12.004,8.272-16.105\r\n\t\tc-1.532-3.673-7.225-4.58-13.027-5.059c-3.206-0.265-14.244-3.774-14.03-7.371C33.965,32.429,35.432,28.217,39.61,26.601z\"/>\r\n\t<path style=\"fill:none;stroke:#000000;stroke-miterlimit:10;\" d=\"M41.432,26.196c-3.254,0.22-6.827,4.743-7.381,7.41\r\n\t\tc-0.854,4.107,1.184,6.737,5.131,8.676c3.564,1.751,7.39,2.32,11.5,2.314c4.28-0.006,10.935-2.236,14.271-4.145\r\n\t\tc2.826-1.617,7.896-5.685,8.756-7.394\"/>\r\n</g>\r\n<line id=\"direct\" style=\"display:none;fill:none;stroke:#FF0000;stroke-miterlimit:10;\" x1=\"-0.068\" y1=\"46.859\" x2=\"85.932\" y2=\"46.859\"/>\r\n<polygon id=\"collider\" style=\"display:none;\" points=\"-3.394000000000016,15.081 -3.7570000000000157,53.028999999999996 12.617999999999984,68.605 34.335999999999984,88.689 42.82799999999999,88.69 55.43199999999999,88.691 61.30899999999999,84.767 81.68199999999999,64.367 83.18199999999999,61.223 84.43199999999999,57.069 86.32,50.793 86.432,38.883 78.387,16.162 71.95299999999999,9.367 64.27499999999999,1.2620000000000005 55.13199999999999,0.32700000000000173 43.74499999999999,0.5210000000000008 38.67299999999999,0.6080000000000008 34.01899999999999,1.7710000000000008 -3.394000000000016,15.081\" fill=\"none\" stroke=\"red\" stroke-width=\"3\"></polygon>\r\n</svg>\r\n";

},{}],21:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\r\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\r\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\r\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\r\n\t y=\"0px\" width=\"206.282px\" height=\"106.533px\" viewBox=\"0 0 206.282 106.533\" style=\"enable-background:new 0 0 206.282 106.533;\"\r\n\t xml:space=\"preserve\">\r\n<g>\r\n\t<g>\r\n\t\t<path style=\"fill:#F7F5F1;stroke:#000000;stroke-miterlimit:10;\" d=\"M18.747,60.339c-2.201-23.171,5.94-51.971,45.796-58.176\r\n\t\t\tc26.476-4.122,40.446-0.039,53.815,6.304c14.366,6.817,94.307,60.091,86.946,66.355c-27.073-17.85-120.328-23.545-143.945-2.635\r\n\t\t\tc-9.851,8.721-13.537,12.361-20.521,22.633C33.359,91.041,19.266,65.798,18.747,60.339z\"/>\r\n\t\t<path style=\"fill:#D9E0D1;\" d=\"M39.97,88.992c-6.839-6.93-16.896-25.408-17.243-29.055C21.402,45.984,22.881,12.819,65.14,6.239\r\n\t\t\tc6.989-1.088,13.182-1.616,18.931-1.616c14.604,0,24.307,3.647,32.615,7.589c6.334,3.007,27.63,16.445,48.061,30.925\r\n\t\t\tc13.784,9.767,22.459,16.642,27.902,21.369c-17.806-6.082-43.813-9.824-69.954-9.824c-30.315,0-53.621,5.24-63.941,14.377\r\n\t\t\tC49.848,76.943,45.83,80.785,39.97,88.992z\"/>\r\n\t\t<path style=\"fill:#9CB098;\" d=\"M37.026,73.792c-2.8-4.666-6.865-10.926-6.667-16.531c0.182-5.126,2.598-14.319,7.874-21.224\r\n\t\t\tc7.021-9.189,15.469-15.317,29.236-19.159c6.235-1.739,12.411-1.77,17.557-1.77c12.906,0,25.183,3.208,32.047,5.611\r\n\t\t\tc8.953,3.134,42.286,20.97,52.286,32.87c-6.722-0.473-30.558-4.231-43-5.929c-19.307-2.636-53.783,8.554-72.657,17.251\r\n\t\t\tC48.69,67.22,39.936,70.837,37.026,73.792z\"/>\r\n\t\t<path style=\"fill:#73776C;\" d=\"M35.359,64.912c0.426-3.232,7.445-18.463,10.667-22.316c6.25-7.473,14.271-10.354,24.579-13.778\r\n\t\t\tc5.93-1.97,14.469-3.465,18.754-3.465c13.023,0,24.334,2.125,29.667,3.742c7.729,2.342,29.622,11.381,31.785,12.595\r\n\t\t\tC112.1,29.095,44.526,57.714,35.359,64.912z\"/>\r\n\t\t<path style=\"fill:#8A7C74;\" d=\"M43.203,55.875c17.823-17.574,51.323-29.255,91.99-18.948\r\n\t\t\tC97.693,29.884,67.573,40.878,43.203,55.875z\"/>\r\n\t</g>\r\n\t<g>\r\n\t\t<path style=\"fill:#F7F5F1;stroke:#000000;stroke-miterlimit:10;\" d=\"M54.145,74.808c0.075-0.08,0.545-0.592,0.137-0.162\r\n\t\t\tc-4.377,4.775-12.519,5.934-17.689,2.74c-5.121-3.162-6.669-9.41-3.595-14.809c1.572-2.762,3.707-5.457,6.204-7.555\r\n\t\t\tc2.376-1.998,6.362-2.735,9.265-3.999c9.015-3.928,13.591,1.568,21.105,3.877c6.81,2.092,10.219,8.305,11.298,14.074\r\n\t\t\tc2.004,10.705-6.006,27.072-18.511,32.814c-13.886,6.377-30.837,5.26-42.688-1.307c-2.34-1.297-4.563-2.84-6.024-4.875\r\n\t\t\tc-1.451-2.021-1.599-4.654-3.277-6.537c-1.444-1.617-4.003-2.258-5.514-3.844c-1.492-1.566-2.426-3.568-3.1-5.512\r\n\t\t\tc-4.104-11.844,2.581-23.803,9.561-34.851c2.241-3.546,4.349-7.508,6.653-11.172c2.398-3.811,5.305-7.358,8.199-10.939\r\n\t\t\tc1.652-2.045,3.547-4.432,6.859-6.096c-1.221,1.461-4.122,6.548-4.52,7.187c-2.715,4.353-5.608,8.71-7.315,13.36\r\n\t\t\tc-4.554,12.403,1.4,26.718,9.471,36.156c0.961,1.123,2.257,1.895,3.345,2.998C39.359,81.779,48.723,80.56,54.145,74.808z\"/>\r\n\t\t<path style=\"fill:#869BC7;\" d=\"M51.89,75.667c-8.921,1.221-22.357-8.469-10.407-18.17c5.376-4.361,23.494-3.992,30.104,3.463\r\n\t\t\tc7.596,8.566,5.859,22.273-1.225,30.307c-4.474,5.072-16.695,10.432-21.077,10.996c-21.523,2.773-31.865-8.93-36.27-14.057\r\n\t\t\tc-5.811-6.764-9.167-15.875-7.656-24.697c0.695-4.063,10.322-19.584,13.409-21.82c-1.528,5.103,5.127,22.691,6.304,24.892\r\n\t\t\tc1.277,2.387,3.365,4.662,5.33,6.559c2.331,2.252,5.492,3.861,8.668,5.17C43.157,79.996,49.46,78.726,51.89,75.667z\"/>\r\n\t\t<path style=\"fill:#545276;\" d=\"M51.89,75.667c-5.408-0.439-11.756-7.938-6.15-12.748c5.962-5.117,14.419-0.529,18.173,3.016\r\n\t\t\tc5.695,5.375,4.246,12.545-0.927,18.852c-2.936,3.58-7.563,7.088-12.326,8.818c-16.627,6.045-29.175-8.557-30.733-11.76\r\n\t\t\tc-2.452-5.041-2.213-12.881-1.85-16.695c0.183-1.939,1.903-5.648,3.303-8.178c0.937,3.697,1.889,6.02,3.065,8.223\r\n\t\t\tc1.276,2.385,10.711,11.572,13.888,12.881C42.417,79.761,47.303,79.337,51.89,75.667z\"/>\r\n\t</g>\r\n</g>\r\n<line id=\"direct\" style=\"display:none;fill:none;stroke:#FF0000;stroke-miterlimit:10;\" x1=\"205.304\" y1=\"74.822\" x2=\"17.969\" y2=\"33.693\"/>\r\n<polygon id=\"collider\" style=\"display:none;\" points=\"24.687,8.368000000000002 22.881,12.819 11.317000000000004,44.86200000000001 4.337000000000004,55.91000000000001 -2.347999999999996,67.86900000000001 1.7560000000000042,79.71300000000001 2.430000000000004,81.65700000000001 3.3640000000000043,83.659 15.108000000000008,97.641 17.331000000000007,99.18400000000001 27.76200000000001,105.03599999999999 31.52200000000001,107.04800000000002 48.47300000000001,108.165 62.35900000000001,101.78800000000001 74.864,96.046 82.87400000000001,79.679 80.87,68.974 122.69500000000001,54.682 138.80100000000002,49.358000000000004 148.836,54.682 162.637,53.11600000000001 169.359,53.589000000000006 174.843,58.424 187.20600000000002,59.778999999999996 192.649,64.506 205.304,74.822 212.66500000000002,68.55799999999999 178.531,52.903999999999996 164.747,43.137 144.316,28.657 132.724,15.283999999999997 118.358,8.466999999999997 104.989,2.1239999999999966 91.019,-1.9590000000000032 64.543,2.1629999999999967 24.687,8.368000000000002\" fill=\"none\" stroke=\"red\" stroke-width=\"3\"></polygon>\r\n</svg>\r\n";

},{}],22:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\n\t y=\"0px\" width=\"155.485px\" height=\"275.009px\" viewBox=\"0 0 155.485 275.009\" style=\"enable-background:new 0 0 155.485 275.009;\"\n\t xml:space=\"preserve\">\n<g>\n\t<g>\n\t\t<g>\n\t\t\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M123.25,40.276c-0.258-0.736-0.416-1.473-0.234-2.209\n\t\t\t\tc-4.225-4.708-12.264-6.981-17.805-9.547c-4.632-2.145-10.057-1.788-14.957-0.962c-3.36,0.566-8.496,2.891-11.893,1.589\n\t\t\t\tc-2.841-1.089-3.965-7.089-4.34-9.56c-0.602-3.97-0.912-7.819-3.848-10.859c-5.59-5.789-16.573-8.513-24.353-8.205\n\t\t\t\tc-4.151,0.165-9.14,1.154-12.748,3.357c-4.891,2.987-6.749,7.471-6.286,13.073c5.662-1.429,16.317-9.71,17.924,2.064\n\t\t\t\tc0.936,6.855-4.789,12.516-9.135,16.996c-5.804,5.982-12.042,11.587-17.287,18.089C1.879,74.452,2.462,105.65,7.521,129.924\n\t\t\t\tc3.048,14.629,7.538,28.863,14.814,41.97c9.273,16.704,29.324,36.839,43.625,49.124c7.554,6.49,47.258,40.424,67.767,40.32\n\t\t\t\tc0.804-0.004,6.821,0.479,7.358-0.32l13.625-20c-3.587-1.319-18.1-4.368-21.002-5.861c-8.857-4.555-17.383-10.186-24.583-17.186\n\t\t\t\tc-2.04-1.982-3.976-4.074-5.778-6.275c-2.219-2.706-4.23-5.598-6.035-8.596c-5.236-8.696-8.718-18.464-11.717-28.121\n\t\t\t\tc-0.877-2.824-1.699-5.666-2.482-8.518c-0.773-2.816-1.547-5.633-2.39-8.43c-4.264-14.143,7.628-19.849,19.729-14.996\n\t\t\t\tc0,0,25.352,0.754,26.925,0.316l0.073-47.871L123.25,40.276z\"/>\n\t\t\t<path style=\"fill:#D9E0D1;\" d=\"M137.967,257.479c-1.094,0-2.315,0.04-3.123,0c-0.525-0.025-0.92,0.057-1.105,0.057h-0.104\n\t\t\t\tc-12.061,0-36.385-14.81-65.067-39.452c-14.171-12.175-33.867-32.108-42.735-48.081c-6.338-11.418-11.047-24.804-14.395-40.869\n\t\t\t\tc-2.995-14.368-8.019-50.207,9.965-72.506c3.529-4.376,7.489-8.299,11.682-12.445c1.766-1.746,3.591-3.554,5.362-5.378\n\t\t\t\tl0.374-0.387c4.653-4.789,11.027-11.349,9.854-19.939c-1.193-8.74-6.953-9.684-9.374-9.684c-2.526,0-5.107,0.868-7.521,1.864\n\t\t\t\tc0.73-1.328,1.846-2.427,3.378-3.363c2.572-1.57,6.618-2.607,10.822-2.774C46.323,4.507,46.673,4.5,47.031,4.5\n\t\t\t\tc6.708,0,15.823,2.407,20.265,7.007c1.688,1.748,2.091,4.019,2.608,7.579l0.162,1.1c1.09,7.19,3.335,11.343,6.863,12.696\n\t\t\t\tc1.135,0.435,2.416,0.655,3.808,0.655c2.53,0,5.081-0.706,7.331-1.329c1.074-0.297,2.088-0.578,2.85-0.707\n\t\t\t\tc2.387-0.402,4.327-0.589,6.107-0.589c2.58,0,4.708,0.405,6.506,1.237c1.455,0.674,3.004,1.301,4.644,1.965\n\t\t\t\tc3.83,1.551,9.815,2.585,12.536,4.921c0.067,0.486,2.471,0.628,2.587,1.019l4.072,53.512l-16.659,29.701\n\t\t\t\tc-1.436,0.547-4.394,2.014-5.5,2.844l-0.5,0.375c-3.141,3.664-4.299,7.013-4.844,11.938c-1.839-0.414-5.951-1.088-7.716-1.088\n\t\t\t\tc-5.688,0-10.599,2.219-13.474,6.088c-2.121,2.855-4.152,7.908-1.784,15.762c0.821,2.723,1.592,5.534,2.34,8.254\n\t\t\t\tc0.871,3.176,1.695,6.002,2.541,8.725c2.818,9.074,6.461,19.615,12.11,28.999c1.953,3.245,4.096,6.296,6.368,9.068\n\t\t\t\tc1.857,2.267,3.904,4.491,6.084,6.608c6.87,6.678,15.464,12.691,25.542,17.874c1.937,0.996,6.226,2.103,13.06,3.808\n\t\t\t\tc1.127,0.281,2.266,0.565,3.336,0.838l-9.611,14.109C138.469,257.475,138.238,257.479,137.967,257.479z\"/>\n\t\t</g>\n\t\t<g>\n\t\t\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M122.242,141.896c1.922-1.834,2.313-6.777,2.219-8.878\n\t\t\t\tc-0.162-3.583-2.639-6.939-5.506-9.201c-3.331-2.627-7.105-0.466-10.494,1.007c-3.655,1.589-5.301,3.781-6.445,7.25\n\t\t\t\tc-0.588,1.782-1.279,3.678-1.561,5.438c-1.459,9.15,1.244,20.072,10.867,22.882c8.02,2.344,15.033-4.454,19.389-10.127\n\t\t\t\tc8.576-11.168,8.284-24.801,5.5-38c-0.646-3.061-6.473-13.766-9.373-17.926\"/>\n\t\t\t<path style=\"fill:#D9E0D1;\" d=\"M128.936,99.718c-1.17-1.676-2.737-2.443-3.379-3.513l-14.846,27.063\n\t\t\t\tc3.389-1.473,3.749-1.826,7.688-0.25c6.25,2.5,9,13.5,3.844,18.878c0,0,1.566-10.582-1.031-13.378c-3-5-10.355-3.25-14.355-0.25\n\t\t\t\tc-4.145,5.75-5.395,17.375-2.645,24.25c5,8,15,7,21,1c8-9,10.125-19.875,10.125-31.875\n\t\t\t\tC135.336,114.307,132.121,106.852,128.936,99.718z\"/>\n\t\t</g>\n\t\t<g>\n\t\t\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M118.825,71.785c1.415,0.235,3.542-2.664,3.919-3.642\n\t\t\t\tc0.7-1.813,0.744-4.07,0.461-6c-0.288-1.951-1.584-3.234-3.246-3.939c-2.184-0.927-4.997-0.854-6.994,0.036\n\t\t\t\tc-4.27,1.901-5.229,4.834-5.872,9.153c-0.673,4.521,0.198,9.171,1.236,13.501c0.937,3.909,4.604,9.007,8.128,10.906\n\t\t\t\tc1.787,0.963,3.46,2.193,5.379,2.941c4.57,1.781,9.603,1.509,12.383-2.904c2.438-3.868,3.541-8.825,3.979-13.332\n\t\t\t\tc1.434-14.728-6.307-30.322-15.879-41.157\"/>\n\t\t\t<path style=\"fill:#D9E0D1;\" d=\"M122.055,39.674l-2.043,18.058c1.662,0.706,3.037,2.367,3.324,4.317\n\t\t\t\tc0.284,1.93,0.262,4.344-0.438,6.156c-0.432,1.117-3.302,4.681-4.629,3.271c4.711-2.89,4.906-10.231,1.454-11.765\n\t\t\t\tc-0.165-0.073-0.33-0.149-0.513-0.194c-2-1-4.75-0.125-6.75,0.875c-5.5,4.813-5.511,11.143-3.312,17.201\n\t\t\t\tc1,2.754,2.144,6.076,3.749,8.549c1.375,2.119,3.133,3.473,5.25,5c5.111,3.686,12.3,5.063,15.063-0.625\n\t\t\t\tC141.711,73.018,128.011,44.711,122.055,39.674z\"/>\n\t\t</g>\n\t\t<g>\n\t\t\t<path style=\"fill:#9CB098;\" d=\"M66.544,59.185c6.303-4.862,16.669-0.9,21.258,5.407c2.807,3.857,5.207,20.671-2.541,20.643\n\t\t\t\tc-0.299,5.19-0.726,10.423-3.969,14.707c-2.618,3.459-6.276,6.011-9.498,8.827c-7.454,6.514-14.259,15.415-15.657,25.083\n\t\t\t\tc-1.374,9.499,3.492,21.544,6.74,30.334c3.32,8.984,6.6,18.809,11.093,27.573c4.507,8.794,12.2,14.649,18.249,22.435\n\t\t\t\tc5.614,7.227,12.502,15.125,19.575,21.074c5.524,4.646,27.974,10.924,28.101,15.25c0.104,3.558-2.548,7.516-4.508,10.357\n\t\t\t\tc-1.595-1.275-12.335-2.713-14.842-3.432c-5.228-1.496-9.673-4.318-14.668-6.674c-9.625-4.542-19.802-8.443-28.748-14.176\n\t\t\t\tc-9.309-5.966-17.517-11.58-26.27-18.734c-8.981-7.342-28.419-45.245-30.982-50.998c-3.9-8.756-8.36-38.797-9.334-45.343\n\t\t\t\tc-0.83-5.574,0.241-11.553,1.325-17.009c2.281-11.487,6.559-21.539,12.594-31.658c2.39-4.006,16.337-19.711,18.415-21.332\n\t\t\t\tc3.461-2.7,10.179-4.771,14.25-2.918C61.612,50.642,66.544,59.185,66.544,59.185z\"/>\n\t\t</g>\n\t\t<path style=\"fill:#8A7C74;\" d=\"M48.381,94.021c-5.087,9.707-3.021,19.351-2.503,30.164c0.976,20.349,4.38,40.224,13.499,58.501\n\t\t\tc8.031,16.097,17.014,30.51,27.332,45.369c1.948,2.805,16.249,17.104,14.031,19.659c-3.395,3.912-20.298-9.781-23.398-12.36\n\t\t\tc-14.355-11.941-21.257-30.684-29.447-46.521c-4.581-8.858-7.219-15.633-9.684-25.029c-2.798-10.671-4.347-23.303-4.333-34.285\n\t\t\tc0.022-17.514,4.833-53.112,30.097-50.15C59.383,79.471,50.338,90.285,48.381,94.021z\"/>\n\t</g>\n\t<g>\n\t\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M7.341,76.406c1.169,10.862-2.1,22.05-2.13,33.112\n\t\t\tc-0.03,11.064,3.227,20.578,6.759,30.667c3.94,11.252,9.595,25.439,18.035,34.125c4.976,5.121,9.241,10.926,14.646,15.628\n\t\t\tc4.664,4.058,10.524,6.21,16.157,8.532c17.463,7.199,28.066,23.819,41.935,35.787c4.338,3.742,10.185,7.646,15.469,10.012\n\t\t\tc4.463,1.998,9.307,2.795,14.125,3.408c4.949,0.629,13.002-0.808,12.281,6.508c-0.479,4.847-0.307,10.5-2.076,14.98\n\t\t\tc-2.035,5.157-8.18,3.869-13.002,4.352c-12.979,1.299-27.094-7.246-38.369-12.514c-12.725-5.947-24.334-13.908-34.696-23.387\n\t\t\tc-5.821-5.324-11.159-11.227-16.015-17.441c-15.853-20.291-25.177-44.707-32.87-69.027c-2.113-6.68-4.035-13.407-5.38-20.29\n\t\t\tc-1.883-9.631-2.128-19.589-1.144-29.339C1.922,93.053,5.26,84.685,7.341,76.406z\"/>\n\t\t<path style=\"fill:#94A4CF;\" d=\"M143.619,254.186c-0.479,4.847-0.307,10.5-2.076,14.98c-2.035,5.157-8.18,3.869-13.002,4.352\n\t\t\tc-12.979,1.299-26.094-7.246-37.369-12.514c-12.725-5.947-24.334-13.908-34.696-23.387c-5.821-5.324-9.909-11.134-14.765-17.35\n\t\t\tc-15.853-20.291-26.427-44.799-34.12-69.119c-2.113-6.68-4.035-13.407-5.38-20.29c-1.883-9.631-2.128-19.589-1.144-29.339\n\t\t\tc0.855-8.467,3.311-13.918,5.519-22.001c0,0-4.345,21.771-4.375,32.833c-0.03,11.064,2.227,20.745,5.759,30.834\n\t\t\tc3.94,11.252,9.595,25.439,18.035,34.125c4.976,5.121,9.241,10.926,14.646,15.628c4.664,4.058,10.524,6.21,16.157,8.532\n\t\t\tc17.463,7.199,28.066,23.819,41.935,35.787c4.338,3.742,10.185,7.646,15.469,10.012c4.463,1.998,9.307,2.795,14.125,3.408\n\t\t\tC133.287,251.307,143.619,254.186,143.619,254.186z\"/>\n\t\t<path style=\"fill:#5E5264;\" d=\"M25.961,198.268c9,7,20.75,25,27.03,29.179c16.182,10.767,32.137,23.438,49.171,32.534\n\t\t\tc9.517,5.081,18.813,8.328,29.471,10.035c-3.59,6.802-9.251,5.436-15.614,3.007c-9.124-3.483-16.333-7.704-25.847-12.019\n\t\t\tc-9.908-4.494-17.544-9.939-25.961-16.736c-12.874-10.396-27.924-21.811-35.896-37.561c-1.434-2.833-0.898-6.805-3.604-8.939\"/>\n\t</g>\n</g>\n<line id=\"direct\" style=\"display:none;stroke:#FF0000;stroke-miterlimit:10;\" x1=\"143.358\" y1=\"257.683\" x2=\"77.742\" y2=\"57.68\"/>\n</svg>\n";

},{}],23:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\n\t y=\"0px\" width=\"204.749px\" height=\"190.243px\" viewBox=\"0 0 204.749 190.243\" style=\"enable-background:new 0 0 204.749 190.243;\"\n\t xml:space=\"preserve\">\n<g>\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M171.025,69.921c6.672-0.441,17.8,0.228,24.027,3.474\n\t\tc7.169,3.737,10.069,12.487,8.971,20.137c-0.55,3.828-2.539,7.061-2.51,11.011c0.027,3.581,1.633,7.688,2.012,11.488\n\t\tc0.972,9.736-2.137,12.381-6.377,20.624c-3.576,6.955,5.772,13.253,3.363,20.862c-2.051,6.475-11.986,9.977-17.961,10.54\n\t\tc-9.361,0.883-14.977-2.645-21.537-8.552c-6.377-5.742-12.635-11.037-19.377-16.086c-5.977-4.475-13.852-10.484-17.611-16.889\n\t\tc-9.17-15.619,5.002-33.455,17.109-42.376C141.134,84.156,163.281,70.434,171.025,69.921z\"/>\n\t<path style=\"fill:#ABB8AD;\" d=\"M179.785,164.193c-6.38,0-10.578-2.692-16.095-7.659c-7.181-6.465-13.427-11.649-19.656-16.314\n\t\tc-4.896-3.666-13.09-9.802-16.56-15.712c-8.168-13.915,6.76-30.249,15.905-37.037c8.266-5.108,23.025-13.235,27.909-13.558\n\t\tc1.135-0.075,2.367-0.113,3.664-0.113c5.908,0,13.805,0.826,18.251,3.143c5.855,3.053,7.661,10.445,6.86,16.021\n\t\tc-0.184,1.273-0.603,2.573-1.047,3.949c-0.715,2.215-1.525,4.727-1.504,7.661c0.019,2.443,0.587,4.87,1.137,7.218\n\t\tc0.387,1.654,0.753,3.217,0.895,4.638c0.651,6.526-0.646,8.831-3.492,13.88c-0.739,1.312-1.576,2.798-2.461,4.518\n\t\tc-2.748,5.342-0.481,10.174,1.34,14.057c1.529,3.261,2.412,5.389,1.766,7.428c-1.23,3.885-8.641,7.21-14.521,7.765\n\t\tC181.352,164.153,180.548,164.193,179.785,164.193z\"/>\n\t<path style=\"fill:#73776C;\" d=\"M144.424,98.685c0.952-0.777,5.62-3.039,6.941-3.239c3.044-0.459,6.108-0.193,9.168-0.053\n\t\tc3.024,0.139,11.485,3.847,12.778,4.849c3.353,2.598,6.266,7.795,1.51,10.754c-2.672,1.662-19.833,3.518-22.814,3.407\n\t\tc-3.318-0.124-7.749-0.89-10.439-2.979C137.048,107.913,141.144,101.366,144.424,98.685z\"/>\n</g>\n<g>\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M98.012,31.251c-4.9-6.507-12.304-12.881-19.303-16.774\n\t\tc-5.245-2.917-13.125-7.203-23.781,2.829C52.334,9.977,35.138,4.086,30.18,4.481C22.13,5.125,9.909,10.967,5.104,17.124\n\t\tc-6.96,8.917-4.806,18-1.499,28.177c3.744,11.518,0.131,15.328-1.082,26.502C1.597,80.331,4.616,89.61,11.74,94.75\n\t\tc4.689,3.383,16.104,4.248,18.663,4.666c7.698,1.257,13.638-10.464,19.052-11.201c5.759-0.784,21.811,7.281,35.018,3.771\n\t\tc7.611-2.022,20.669-8.48,17.484-16.477c-2.676-6.718-3.513-9.312-0.423-15.362C106.259,50.891,104.087,39.318,98.012,31.251z\"/>\n\t<path style=\"fill:#ABB8AD;\" d=\"M83.445,88.121c-7.389,1.963-16.182-0.292-23.248-2.103c-4.699-1.206-8.411-2.157-11.283-1.766\n\t\tc-0.345,0.047-0.689,0.116-1.035,0.208c-3.074,0.817-5.62,3.222-8.316,5.769c-2.263,2.138-4.827,4.561-7.04,5.148\n\t\tc-0.522,0.139-1.005,0.168-1.477,0.091c-0.447-0.073-1.142-0.16-2.016-0.268c-3.241-0.398-11.85-1.457-14.951-3.694\n\t\tC8.631,87.575,5.655,80.01,6.5,72.234c0.35-3.221,0.907-5.767,1.446-8.229c1.283-5.866,2.392-10.931-0.537-19.941\n\t\tc-3.143-9.67-4.922-17.087,0.848-24.479c3.122-4,10.845-8.443,17.965-10.335c1.57-0.417,3.008-0.68,4.276-0.781\n\t\tc3.732-0.298,18.9,5.201,20.66,10.172l2.046,5.782l4.466-4.204c2.707-2.548,5.345-4.177,7.841-4.84\n\t\tc4.459-1.185,8.069,0.823,11.254,2.595c6.623,3.684,13.54,9.694,18.052,15.685c5.614,7.456,6.882,17.37,3.154,24.671\n\t\tC94.117,65.876,95.34,69.71,98.24,76.99c0.318,0.797,0.27,1.501-0.159,2.354C96.305,82.875,89.245,86.579,83.445,88.121z\"/>\n\t<path style=\"fill:#73776C;\" d=\"M74.494,33.017c-3.229-2.419-12.945-3.286-24.313,1.632c-5.273,2.281-12.528,7.917-14.932,10.503\n\t\tc-4.539,4.881-7.997,11.518-8.417,18.255c-0.198,3.167,0.228,6.897,1.768,9.706c1.845,3.362,5.247,4.684,8.96,4.442\n\t\tc3.083-0.201,15.194-2.719,21.925-7.035c5.913-3.791,13.41-14.754,14.746-17.216C76.694,48.765,77.531,35.292,74.494,33.017z\"/>\n</g>\n<g>\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M169.208,44.2c-3.065-7.547-8.583-15.608-14.348-21.168\n\t\tc-4.319-4.166-10.835-10.332-23.71-3.374c-0.625-7.75-15.732-17.859-20.625-18.75c-7.944-1.446-21.257,1.062-27.482,5.778\n\t\tc-9.017,6.831-9.268,16.162-8.685,26.847c0.66,12.093-3.81,14.847-7.852,25.336c-3.084,8.004-2.55,17.748,3.015,24.545\n\t\tc3.663,4.474,14.473,8.241,16.839,9.302c7.117,3.191,15.867-6.611,21.289-5.933c5.768,0.721,19.209,12.638,32.875,12.638\n\t\tc7.875,0,22.153-2.889,21.129-11.435c-0.861-7.18-1.004-9.901,3.536-14.955C172.135,65.299,173.007,53.556,169.208,44.2z\"/>\n\t<path style=\"fill:#ABB8AD;\" d=\"M140.525,95.42c-7.646,0-15.564-4.437-21.928-8.002c-4.232-2.372-7.574-4.245-10.451-4.604\n\t\tc-0.345-0.043-0.695-0.064-1.054-0.064c-3.181,0-6.259,1.671-9.518,3.44c-2.736,1.485-5.837,3.168-8.126,3.168\n\t\tc-0.54,0-1.014-0.095-1.451-0.291c-0.413-0.185-1.063-0.448-1.88-0.776c-3.03-1.217-11.078-4.451-13.501-7.41\n\t\tc-4.257-5.199-5.19-13.274-2.377-20.573c1.165-3.023,2.357-5.341,3.511-7.582c2.747-5.339,5.119-9.95,4.603-19.41\n\t\tc-0.554-10.153-0.369-17.778,7.106-23.44C89.502,6.811,98.108,4.5,105.475,4.5c1.624,0,3.082,0.115,4.333,0.343\n\t\tc3.684,0.67,16.931,9.88,17.355,15.136l0.492,6.113l5.396-2.916c3.27-1.768,6.238-2.664,8.82-2.664\n\t\tc4.614,0,7.588,2.868,10.211,5.397c5.455,5.262,10.596,12.847,13.418,19.794c3.512,8.647,2.191,18.555-3.287,24.654\n\t\tc-5.662,6.304-5.465,10.324-4.533,18.104c0.104,0.852-0.124,1.52-0.758,2.234C154.3,93.653,146.526,95.42,140.525,95.42z\"/>\n\t<path style=\"fill:#73776C;\" d=\"M146.025,39.866c-2.5-3.167-11.666-6.5-23.916-4.667c-5.684,0.851-14.142,4.435-17.129,6.316\n\t\tc-5.64,3.552-10.687,9.078-12.823,15.481c-1.004,3.01-1.551,6.724-0.784,9.834c0.919,3.723,3.869,5.874,7.519,6.594\n\t\tc3.031,0.598,15.383,1.274,22.996-1.168c6.688-2.145,16.75-10.816,18.673-12.852C144.107,55.651,148.375,42.844,146.025,39.866z\"/>\n</g>\n<g>\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M178.125,162.909c-5.379-4.278-6.361-10.575-8.963-16.488\n\t\tc-5-11.367-15.344-21.799-26.137-27.889c3.749-8.738-12.314-34.336-16.155-38.364c-8.829-9.26-42.138-25.064-73.307,1.654\n\t\tc-6.179,5.296-9.075,13.664-10.36,21.461c-0.996,6.042-1.016,12.128-0.697,18.288c1.02,19.711,20.032,44.809,32.104,51.211\n\t\tc7.888,4.184,18.875,19.391,34.83,16.628c4.586-0.794,19.92-12.011,20.572-18.938c8.874,7.736,15.805,18.643,28.902,10.424\n\t\tc5.352-3.357,9.34-6.486,15.611-7.837c6.199-1.336,12.389-1.857,18.45-0.628C189.25,167.554,182.81,166.636,178.125,162.909z\"/>\n\t<path style=\"fill:#ABB8AD;\" d=\"M104.295,186.13c-7.399,0-13.901-5.659-19.638-10.652c-2.989-2.601-5.57-4.848-8.175-6.229\n\t\tc-11.168-5.924-29.044-29.732-29.983-47.885c-0.368-7.103-0.167-12.479,0.649-17.431c1.177-7.142,4.508-14.042,9.38-19.428\n\t\tc4.038-4.464,26.111-13.803,42.292-12.99c10.287,0.517,21.687,8.494,25.457,11.7c3.943,3.354,17.684,27.65,15.07,33.74\n\t\tl-1.415,3.298l3.126,1.764c10.662,6.016,20.028,15.984,24.44,26.016c0.61,1.389,1.129,2.812,1.677,4.318\n\t\tc1.673,4.594,3.568,9.8,8.457,13.689c1.064,0.846,2.168,1.553,3.283,2.181c-1.68,0.228-3.419,0.536-5.235,0.928\n\t\tc-5.939,1.28-10.028,3.929-14.358,6.733c-0.818,0.531-1.658,1.074-2.536,1.625c-2.482,1.559-4.683,2.314-6.726,2.314\n\t\tc-4.482,0-18.787-10.371-20.537-12.289C127.941,170.616,115.435,186.13,104.295,186.13z\"/>\n\t<path style=\"fill:#73776C;\" d=\"M104.098,107.532c19.032,9.094,42.105,47.434,37.525,50.382\n\t\tc-4.476-3.89-28.341-12.956-33.095-14.384c-10.508-3.154-21.674-5.223-31.303-10.758c-4.868-2.8-3.296-3.258-5.799-8.186\n\t\tc-4.233-8.337-4.787-17.397,3.182-22.379C79.934,98.88,99.426,105.301,104.098,107.532z\"/>\n</g>\n<line id=\"direct\" style=\"display:none;stroke:#FF0000;stroke-miterlimit:10;\" x1=\"43.202\" y1=\"103.283\" x2=\"171.025\" y2=\"69.921\"/>\n</svg>\n";

},{}],24:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\n\t y=\"0px\" width=\"92.016px\" height=\"116.81px\" viewBox=\"0 0 92.016 116.81\" style=\"enable-background:new 0 0 92.016 116.81;\"\n\t xml:space=\"preserve\">\n<g>\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M80.064,61.931c3.539,4.803,6.511,20.876,6.747,25.719\n\t\tc0.306,6.266-1.299,12.248-5.125,17.281c-4.258,5.602-9.673,9.563-16.757,10.504c-5.822,0.772-12.614,1.676-18.243-0.41\n\t\tc-7.417-2.748-11.031-10.428-13.007-17.561c-0.596-2.152-0.895-5.359-0.116-7.498c-1.78-1.404-4.294-0.142-6.224,0.041\n\t\tc-1.944,0.186-3.919,0.061-5.831-0.335C13.21,87.955,7.482,81.225,5.668,73.129c-0.846-3.776-1.537-8.04-0.441-11.831\n\t\tc1.71-5.92,8.396-8.982,13.743-10.941c2.476-0.907,0.719-3.702,0.802-5.775c0.192-4.815,1.657-10.459,5.567-13.577\n\t\tc3.553-2.833,8.645-3.69,13.07-3.951c6.93-0.409,13.356,2.868,17.934,7.969c2.462,2.743,4.356,6.074,5.218,9.676\n\t\tc0.396,1.66,1.668,4.225,1.668,4.225C69.02,51.536,74.688,54.635,80.064,61.931z\"/>\n\t<path style=\"fill:#D9E0D1;\" d=\"M54.959,112.31c-2.751,0-5.003-0.339-6.883-1.035c-4.814-1.785-8.263-6.651-10.542-14.878\n\t\tc-0.49-1.769-0.585-4.039-0.212-5.063l0.99-2.718l-2.272-1.792c-1.273-1.005-2.804-1.514-4.55-1.514\n\t\tc-1.256,0-2.417,0.267-3.351,0.48c-0.447,0.103-0.909,0.208-1.178,0.234c-0.46,0.044-0.932,0.065-1.403,0.065\n\t\tc-1.072,0-2.162-0.113-3.24-0.336c-6.289-1.301-11.174-6.475-12.748-13.5c-0.723-3.227-1.348-6.92-0.502-9.847\n\t\tc1.193-4.13,6.653-6.603,11.275-8.296c3.295-1.207,4.509-4.007,3.608-8.321c-0.073-0.349-0.184-0.877-0.185-1.063\n\t\tc0.19-4.753,1.709-8.719,4.063-10.596c2.231-1.778,5.768-2.788,10.813-3.085c0.311-0.019,0.621-0.027,0.93-0.027\n\t\tc4.958,0,9.984,2.433,13.792,6.675c2.146,2.391,3.635,5.135,4.304,7.935c0.478,1.999,1.729,4.575,1.975,5.071l0.636,1.281\n\t\tl1.303,0.589c5.222,2.355,10.317,5.025,15.262,11.734c2.668,3.621,5.72,18.377,5.972,23.541c0.273,5.605-1.178,10.54-4.314,14.666\n\t\tc-4.031,5.304-8.644,8.234-14.099,8.958C61.284,111.883,58.072,112.31,54.959,112.31z\"/>\n\t<path style=\"fill:#ABB8AD;\" d=\"M68.937,80.983c-0.78,3.658-1.938,6.666-5.333,9.666c-2.529,2.235-4.956,4.445-8.246,5.232\n\t\tc-1.832,0.438-3.709-0.128-5.526-0.375c-2.569-0.351-9.198-5.57-9.509-7.09c-0.278-1.367-0.979-2.613-1.965-3.599\n\t\tc-2.007-2.007-5.131-2.502-7.837-2.502c-2.982,0-5.58-0.003-8.079-1.747c-1.757-1.227-3.089-2.939-4.278-4.698\n\t\tc-1.2-1.776-2.451-3.597-3.375-5.534c-1.137-2.383-1.135-4.742-0.183-7.166c1.036-2.638,2.569-4.283,4.727-6.019\n\t\tc3.527-2.837,7.867-4.542,11.46-7.146c3.331-2.415,8.964-0.696,12.727-0.106c7.946,1.245,18.44,10.718,20.833,13.943\n\t\tC66.437,66.649,69.434,78.652,68.937,80.983z\"/>\n\t<path style=\"fill:#73776C;\" d=\"M48.562,64.399c3.823,0.813,7.477,3.666,8.882,7.619c1.209,3.4,0,7.826-3.632,9.287\n\t\tc-3.521,1.416-8.196,1.109-11.53-0.628c-3.024-1.575-5.634-3.742-8.966-4.406c-1.793-0.356-4.005-0.161-5.656-1.216\n\t\tc-1.831-1.17-2.364-3.189-1.753-5.158c1.159-3.732,5.891-4.182,9.156-4.741c2.172-0.372,4.364-0.551,6.625-0.757\n\t\tC42.79,64.3,46.88,64.042,48.562,64.399z\"/>\n</g>\n<g>\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M58.854,32.566c-2.014-4.99-9.836-3.809-12.675-0.324\n\t\tc-3.238,3.973-2.805,9.776-1.066,14.065c3.226,7.961,11.821,16.523,20.759,16.961c10.174,0.496,21.178-4.46,24.397-15.027\n\t\tc3.395-11.14-0.568-19.441-6.748-29.007c-2.754-4.263-6.271-7.555-11.326-9.083c-5.765-1.742-11.819,1.049-17.949,0.69\n\t\tC45.309-12.536,10.284,8.758,6.187,25.233C4.617,31.543,6.649,36.577,7.804,42.5c-6.385,5.743-9.392,18.506-5.701,26.149\n\t\tc2.854,5.908,14.438,16.617,21.766,12.066c0.002,0-0.039,0.02-0.033,0.016c2.097-0.344,4.311-7.68,4.447-8.99\n\t\tc0.951-9.182,1.435-18.613,2.731-22.888c2.074-6.844,3.672-11.828,13.404-13.222\"/>\n\t<path style=\"fill:#94A4CF;\" d=\"M57.312,33.025c-1.438-1.086-3.878,0.271-5.375,0.875c-2.384,0.961-3.409,2.519-3.996,5\n\t\tc-0.923,3.895,1.509,7.494,3.496,10.622c2.158,3.397,4.263,6.068,8.03,7.597c3.657,1.484,9.294,1.373,13.095,0.409\n\t\tc4.318-1.095,7.654-3.371,10.595-6.531c3.407-3.663,4.772-7.634,4.53-12.597c-0.229-4.682-2.41-8.695-4.344-12.994\n\t\tc-2.048-4.551-4.961-7.729-9.031-10.503c-3.718-2.534-8.34-1.58-12.5-1.006c-2.135,0.295-10.529,1.967-12.278,0.912\n\t\tc-1.929-1.164-1.684-4.718-3.525-6.034c-3.8-2.714-11.617-5.927-20.953-0.719c-4.192,2.338-7.411,5.151-10.244,8.969\n\t\tc-2.604,3.509-5.78,8.313-4.868,12.75c0.407,1.981,0.864,4.059,0.965,6.125c0.085,1.749,1.023,4.401,0.434,5.906\n\t\tc-0.451,1.149-2.049,1.811-2.809,2.819C3.556,51.23,1.827,61.898,6.016,69.31c2.078,3.678,5.245,6.923,9.003,8.859\n\t\tc3.444,1.774,6.948,0.927,10.601-0.85c4.494-2.186,2.868-20.632,6.192-31.669c2.827-9.389,10.794-11.564,12.5-13.616\n\t\tc1.487-1.789,2.985-2.184,5.25-2.634c3.197-0.635,5.082-0.914,7.842,1.166c1.5,1.131,2.358,3.932-0.217,2.209\"/>\n\t<path style=\"fill:#5E5264;\" d=\"M51.187,28.775c-1.515-1.199-2.234-2.75-4.402-3.097c-1.95-0.312-4.269,0.679-6.098,1.25\n\t\tc-4.947,1.544-9.034,3.767-12,8.188c-3.333,4.968-5.118,10.746-5.125,16.659c-0.005,4.25,1.273,9.304,5.125,11.762\n\t\tc1.392-1.056,0.179-5.419,0.125-6.915c-0.096-2.65,0.211-5.666,0.747-8.222c0.872-4.162,3.028-7.624,6.656-9.966\n\t\tc2.397-1.547,5.327-2.976,8.204-2.803c0.31-2.605,3.079-5.08,5.472-5.854c-0.179-0.09-0.221-0.276-0.328-0.378\"/>\n</g>\n<line id=\"direct\" style=\"display:none;stroke:#FF0000;stroke-miterlimit:10;\" x1=\"7.887\" y1=\"79.149\" x2=\"80.064\" y2=\"61.931\"/>\n</svg>\n";

},{}],25:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\n\t y=\"0px\" width=\"101.209px\" height=\"83.532px\" viewBox=\"0 0 101.209 83.532\" style=\"enable-background:new 0 0 101.209 83.532;\"\n\t xml:space=\"preserve\">\n<g>\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M29.401,4.501c7.986-4.089,18.018-4.612,26.596-3.481\n\t\tc12.183,1.606,26.581,20.879,21.535,31.632c18.166,6.636,28.166,25.333,20.666,45.833c-2.651-3.086-7.684-4.486-11-6.466\n\t\tc-2.034-1.214-7.349,0.229-10.333,1.966c-8.795,5.115-14.59,9.551-25.5,9C37.35,82.277,8.144,78.849,8.063,58.583\n\t\tc-10.954-4.678-9.928-37.306,2.549-41.047C11.948,13.152,24.324,7.101,29.401,4.501z\"/>\n\t<path style=\"fill:#ABB8AD;\" d=\"M53.171,79.032c-0.521,0-1.056-0.014-1.604-0.042c-14.727-0.743-39.439-4.386-39.504-20.423\n\t\tl-0.011-2.63l-2.418-1.033C6.732,53.665,4.042,46.854,4.562,37.6c0.466-8.295,3.494-15.122,7.198-16.232l2.053-0.616l0.625-2.05\n\t\tc0.538-1.207,3.724-3.992,15.744-10.109l1.042-0.532C35.775,5.731,41.64,4.5,48.185,4.5c2.392,0,4.844,0.163,7.288,0.486\n\t\tc5.442,0.717,12.496,6.652,16.408,13.805c2.607,4.767,3.366,9.313,2.029,12.162l-1.856,3.957l4.105,1.5\n\t\tc8.012,2.927,14.304,8.494,17.717,15.678c2.879,6.058,3.576,12.818,2.082,19.798c-1.138-0.608-2.292-1.14-3.393-1.647\n\t\tc-1.237-0.57-2.407-1.109-3.318-1.652c-1.128-0.674-2.535-1.015-4.183-1.015c-3.522,0-7.763,1.532-10.211,2.958\n\t\tc-1.082,0.629-2.119,1.248-3.127,1.849C65.255,76.24,60.579,79.032,53.171,79.032z\"/>\n\t<path style=\"fill:#73776C;\" d=\"M37.252,34.753c2.725-0.581,5.63-0.73,8.112-1.096c2.885-0.426,4.899-0.854,7.667,0.365\n\t\tc2.541,1.119,4.551,3.033,6.822,4.572c3.497,2.371,7.257,5.129,9.791,8.655c1.725,2.4,2.375,6.735,0.887,9.069\n\t\tc-2.667-2.333-13.586-2.817-15.975-2.541c-5.279,0.61-10.647,1.872-15.982,1.166c-2.697-0.357-5.281-1.296-7.324-3.148\n\t\tc-3.455-3.134-4.268-8.534-1.65-12.524C31.349,36.604,34.186,35.406,37.252,34.753z\"/>\n</g>\n<line id=\"direct\" style=\"display:none;stroke:#FF0000;stroke-miterlimit:10;\" x1=\"0.687\" y1=\"35.823\" x2=\"99.057\" y2=\"75.854\"/>\n</svg>\n";

},{}],26:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\n\t y=\"0px\" width=\"63.618px\" height=\"68.979px\" viewBox=\"0 0 63.618 68.979\" style=\"enable-background:new 0 0 63.618 68.979;\"\n\t xml:space=\"preserve\">\n<g>\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M1.068,62.987c1.091,3.029,6.348,3.206,9.018,3.693\n\t\tc13.038,2.377,28.108,3.773,39.298-4.953c8.088-6.308,13.619-16.641,13.732-26.95c0.06-5.421-1.099-13.33-3.98-18.04\n\t\tC54.239,8.732,47.474,2.772,38.318,0.932c-8.306-1.669-20.165,1.672-26.75,7.108c-9.129,7.536-10.092,21.746-5.25,31.027\n\t\tc1.794,3.438,5.25,8.42,10.887,9.379c4.437,0.754,12.416,0.049,16.312-2.434c-0.015,1.434-3.725,4.576-5.011,5.663\n\t\tc-2.527,2.137-5.908,2.68-8.943,3.306c-5.977,1.23-13.487,1.738-19.013-1.399L1.068,62.987z\"/>\n\t<path style=\"fill:#94A4CF;\" d=\"M26.897,64.479c-5.832,0-11.664-0.927-16.094-1.734c-0.484-0.088-1.046-0.169-1.651-0.254\n\t\tc-1.011-0.143-7.233-0.791-8.181-1.252L0.55,53.582c1.88,0.384,8.948,2.347,11.109,2.347c2.912,0,5.48-0.168,8.826-0.857\n\t\tc0,0,4.91-0.766,8.021-3.396c4.722-3.991,5.673-2.312,5.697-4.726l-0.01-2.213c-1.936,1.233-7.517,1.533-11.625,1.533\n\t\tc-1.225,0-3.807-1.617-4.692-1.768c-3.817-0.648-6.464-4.32-8.012-7.287c-3.96-7.591-3.461-19.725,4.251-26.091\n\t\tC18.84,7.224,26.878,4.5,33.663,4.5c1.399,0,2.701,0.119,3.867,0.353c7.299,1.467,13.42,6.168,18.193,13.972\n\t\tc2.301,3.761,3.448,10.85,3.393,15.909c-0.097,8.781-4.882,18.138-12.192,23.839C41.828,62.547,35.277,64.479,26.897,64.479z\"/>\n\t<path style=\"fill:#5E5264;\" d=\"M29.834,31.385c-3.06,0.445-0.599-5.481,2-7.397c3.425-2.526,7.429-4.643,11.484-3.083\n\t\tc3.372,1.297,6.086,6.933,6.417,10.417c0.666,7-4.139,13.887-7,17.833c-2.417,3.333-8.981,7.952-12.702,9.413\n\t\tc-3.212,1.26-29.591,1.178-29.483-1.163c0.082-1.786,8.079-1.343,9.735-1.615c3.727-0.614,7.312,0.005,10.84-1.274\n\t\tc2.917-1.057,5.977-1.901,8.466-3.838c4.581-3.563,13.87-10.783,13.228-16.689c-0.415-3.817-2.231-8.809-5.583-8\n\t\tC34.818,26.571,32.568,30.987,29.834,31.385z\"/>\n</g>\n<line id=\"direct\" style=\"display:none;stroke:#FF0000;stroke-miterlimit:10;\" x1=\"0.972\" y1=\"61.239\" x2=\"56.946\" y2=\"13.483\"/>\n</svg>\n";

},{}],27:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\n\t y=\"0px\" width=\"107.076px\" height=\"71.828px\" viewBox=\"0 0 107.076 71.828\" style=\"enable-background:new 0 0 107.076 71.828;\"\n\t xml:space=\"preserve\">\n<g>\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M92.41,52.587c-7.908,4.057-16.25,5.727-23.157,10.418\n\t\tc-8.218,5.582-13.833,8.141-24.186,8.318C25.271,71.661,10.169,53.814,2.266,38.071C-1.56,30.451,1.37,23.02,5.922,15.179\n\t\tC11.916,4.85,19.604,5.002,29.729,5.166c8.73,0.141,18.728-5.286,27.455-4.607c11.731,0.912,16.969,5.323,24.044,12.535\n\t\tc6.202,6.321,15.105,8.538,23.647,5.75C108.49,17.664,107.212,44.993,92.41,52.587z\"/>\n\t<path style=\"fill:#ABB8AD;\" d=\"M44.514,67.328c-21.42,0-35.017-23.768-38.673-31.052c-2.912-5.801-0.805-11.605,3.54-19.089\n\t\tc4.003-6.897,8.386-8.062,16.695-8.062c1.135,0,2.303,0.019,3.506,0.039l0.484,0.005c4.583,0,9.24-1.251,13.744-2.461\n\t\tC48.037,5.572,52.03,4.5,55.631,4.5c0.418,0,0.832,0.015,1.244,0.046c10.113,0.787,14.512,4.228,21.498,11.348\n\t\tc5.146,5.245,11.951,8.134,19.16,8.134c1.694,0,3.39-0.16,5.069-0.479c0.091,6.105-2.697,20.696-12.018,25.478\n\t\tc-3.1,1.59-6.394,2.837-9.578,4.042c-4.713,1.783-9.585,3.627-14.001,6.626c-7.573,5.145-12.547,7.467-22.007,7.628L44.514,67.328z\n\t\t\"/>\n\t<path style=\"fill:#73776C;\" d=\"M64.914,32.19c1.688,0.748,3.144,1.758,4.807,2.566c1.101,0.535,3.097,3.469,3.097,3.469\n\t\ts-2.95,2.808-4.196,3.564c-3.365,2.047-7.029,4.797-10.916,5.602c-2.29,0.475-4.717-0.15-6.987-0.346\n\t\tc-2.578-0.221-5.235-1.168-7.63-2.082c-5.368-2.047-10.816-5.757-10.516-12.12c0.322-6.852,9.999-7.368,14.989-6.538\n\t\tc2.278,0.379,4.992,0.981,7.063,1.766C56.099,28.632,63.772,31.685,64.914,32.19z\"/>\n</g>\n<line id=\"direct\" style=\"display:none;stroke:#FF0000;stroke-miterlimit:10;\" x1=\"2.266\" y1=\"38.071\" x2=\"106.38\" y2=\"21.125\"/>\n</svg>\n";

},{}],28:[function(require,module,exports){
module.exports = "<?xml version=\"1.0\" encoding=\"iso-8859-1\"?>\n<!-- Generator: Adobe Illustrator 16.0.2, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg version=\"1.1\" id=\"&#x5716;&#x5C64;_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\"\n\t y=\"0px\" width=\"83px\" height=\"75.159px\" viewBox=\"0 0 83 75.159\" style=\"enable-background:new 0 0 83 75.159;\"\n\t xml:space=\"preserve\">\n<g>\n\t<path style=\"fill:#E9E1EE;stroke:#000000;stroke-miterlimit:10;\" d=\"M73.108,46.877c-3.386,5.655-9.615,8.431-13,13.611\n\t\tc-4.027,6.165-7.17,9.489-14.375,12.401c-13.779,5.569-29.922-3.004-40.361-12.025c-5.053-4.367-5.309-10.418-4.556-17.195\n\t\tc0.992-8.928,6.433-10.891,13.584-13.5c6.166-2.25,11.489-8.784,17.821-10.653c8.512-2.513,13.558-0.799,20.762,2.403\n\t\tc6.315,2.808,13.249,1.98,18.374-2.294c3.79-3.161,9.043-7.206,5.376-16.624C86.15,15.086,83.393,29.703,73.108,46.877z\"/>\n\t<path style=\"fill:#ABB8AD;\" d=\"M36.364,70.659c-12.222,0-23.916-8.966-28.377-12.82c-3.14-2.714-4.006-6.435-3.195-13.728\n\t\tc0.681-6.127,3.339-7.396,10.923-10.163c3.537-1.291,6.567-3.544,9.497-5.723c2.831-2.105,5.505-4.094,8.143-4.872\n\t\tc2.374-0.701,4.478-1.042,6.43-1.042c3.577,0,6.704,1.099,11.574,3.264c2.959,1.315,6.039,1.982,9.155,1.982\n\t\tc4.958,0,9.594-1.681,13.405-4.86l0.288-0.239c1.232-1.025,2.81-2.337,4.22-4.046c0.354,7.388-2.55,16.056-8.75,26.41\n\t\tc-1.435,2.396-3.651,4.283-5.999,6.281c-2.452,2.087-4.988,4.245-6.918,7.197c-3.642,5.576-6.188,8.32-12.525,10.882\n\t\tC41.811,70.162,39.162,70.659,36.364,70.659z\"/>\n\t<path style=\"fill:#73776C;\" d=\"M47.481,39.835c1.416,0.075,2.751,0.398,4.169,0.523c0.938,0.082,3.25,1.623,3.25,1.623\n\t\ts-1.196,2.783-1.834,3.654c-1.724,2.354-3.438,5.289-5.914,6.905c-1.458,0.952-3.354,1.163-5.007,1.636\n\t\tc-1.877,0.537-4.035,0.582-6,0.58c-4.4-0.005-9.375-1.166-11.144-5.752c-1.905-4.939,4.722-7.91,8.479-8.666\n\t\tc1.715-0.344,3.807-0.648,5.502-0.65C40.192,39.689,46.522,39.785,47.481,39.835z\"/>\n</g>\n<line id=\"direct\" style=\"display:none;stroke:#FF0000;stroke-miterlimit:10;\" x1=\"0\" y1=\"54.757\" x2=\"78.455\" y2=\"0\"/>\n</svg>\n";

},{}],29:[function(require,module,exports){
module.exports = "<svg width=\"644\" height=\"597\" xmlns=\"http://www.w3.org/2000/svg\">\r\n\r\n \r\n <g id=\"SvgjsG1684\">\r\n   <g id=\"svg_1\">\r\n    <g id=\"B_18_\">\r\n     <path d=\"m82.771,23.285c-0.623,7.449 0.516,14.706 -0.818,21.477c-1.592,8.057 -1.808,13.27 0.912,21.842c5.213,16.386 21.67,24.722 34.696,27.615c6.304,1.401 10.623,-2.726 14.779,-8.28c5.475,-7.317 6.27,-13.669 5.278,-23.103c-0.786,-7.533 -2.251,-14.356 -6.661,-21.548c-5.326,-8.694 -10.968,-13.705 -17.884,-17.874c-6.062,-3.659 -10.041,-10.485 -10.467,-18.162c-0.178,-3.252 -18.672,4.09 -19.835,18.033z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__27_\"></path>\r\n     <path d=\"m87.11,65.256c-2.462,-7.738 -2.246,-12.087 -0.779,-19.511c0.875,-4.428 0.804,-8.912 0.736,-13.249c-0.043,-2.882 -0.089,-5.863 0.151,-8.739c0.589,-7.039 7.353,-12.051 11.521,-13.907c0.227,1.058 0.507,2.107 0.848,3.133c2.04,6.103 6.042,11.206 11.276,14.357c7.125,4.296 11.857,9.027 16.331,16.326c1.551,2.531 2.75,5.096 3.665,7.843c1.104,3.306 1.82,6.923 2.324,11.733c0.972,9.287 -0.094,14.113 -4.404,19.876c-4.228,5.653 -6.937,7.388 -10.348,6.633c-5.864,-1.299 -25.448,-6.887 -31.192,-24.099l-0.129,-0.396z\" class=\"B4\" id=\"_x34__12_\"></path>\r\n     <path d=\"m117.304,61.948c-0.496,-1.488 -1.19,-2.788 -1.73,-4.26c-0.355,-0.97 -2.435,-2.814 -2.435,-2.814s-2.131,2.437 -2.722,3.488c-1.592,2.828 -3.705,5.887 -4.405,9.216c-0.413,1.959 -0.03,4.085 0.046,6.055c0.082,2.24 0.693,4.579 1.287,6.682c1.333,4.722 3.876,9.583 8.52,9.577c5.003,-0.007 5.666,-8.351 5.209,-12.704c-0.206,-1.986 -0.567,-4.354 -1.076,-6.179c-0.363,-1.296 -2.361,-8.052 -2.694,-9.061z\" class=\"B1\" id=\"_x31__7_\"></path>\r\n    </g>\r\n    <g id=\"svg_2\">\r\n     <path id=\"svg_3\" d=\"m187.531,90.597c-0.31,-6.276 -6.153,-16.052 -10.48,-20.333c-13.16,-13.027 -37.388,-10.557 -50.434,1.406c-11.017,10.105 -15.648,25.697 -13.259,40.4l21.07,10.566c-0.575,-2.017 -4.085,-19.954 0.571,-27.224c4.514,-7.047 14.929,-8.009 21.378,-2.607c3.121,2.61 4.3,7.475 5.915,10.885c1.92,4.06 3.813,10.848 9.762,10.452c12.935,-0.858 15.886,-15.221 15.477,-23.545z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E5DFDE\"></path>\r\n     <path id=\"svg_4\" d=\"m183.533,90.795c-0.168,-3.492 -2.993,-9.651 -6.716,-14.648c-0.899,-1.207 -1.79,-2.257 -2.581,-3.041c-11.716,-11.601 -33.766,-8.713 -44.916,1.512c-9.2,8.436 -13.812,21.627 -12.292,34.819l6.031,3.027c-2.373,-11.72 2.979,-27.697 12.135,-31.769c4.919,-2.187 9.397,-3.613 14.662,-2.078c7.418,2.171 13.711,8.552 13.104,16.46c0.714,1.423 1.292,2.874 1.826,4.221c0.388,0.976 0.756,1.9 1.123,2.68c0.293,0.629 0.589,1.309 0.897,2.027c0.724,1.684 1.473,3.422 2.402,4.675c1.08,1.44 1.868,1.516 2.58,1.47c12.508,-0.829 11.783,-18.603 11.745,-19.355z\" fill=\"#ABB8AD\"></path>\r\n     <path id=\"svg_5\" d=\"m150.529,77.85c-5.391,-2.219 -11.385,-0.816 -16.007,1.943c-11.652,6.963 -13.835,20.947 -11.458,32.669l6.114,3.069c-0.843,-6.952 -1.145,-16.659 2.452,-22.274c2.632,-4.11 7.047,-6.91 12.119,-7.688c5.486,-0.841 11.021,0.679 15.194,4.166c0.796,0.661 1.536,1.457 2.21,2.361c0.705,0.945 1.29,1.955 1.809,2.977c0.604,-7.903 -5.347,-14.127 -12.433,-17.223z\" fill=\"#73776C\"></path>\r\n    </g>\r\n    <g id=\"svg_6\">\r\n     <path id=\"svg_7\" d=\"m41.205,75.764c0.625,-6.251 6.963,-15.716 11.503,-19.772c13.804,-12.338 37.876,-8.64 50.298,3.973c10.487,10.651 12.906,31.258 9.768,45.818l-21.582,9.484c0.68,-1.99 6.514,-24.521 2.233,-32.018c-4.149,-7.269 -14.5,-8.755 -21.221,-3.693c-3.246,2.445 -4.673,7.246 -6.458,10.567c-2.127,3.961 -4.362,10.642 -10.282,9.942c-12.875,-1.514 -15.092,-16.008 -14.259,-24.301z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E5DFDE\"></path>\r\n     <path id=\"svg_8\" d=\"m45.185,76.164c0.347,-3.475 3.483,-9.484 7.455,-14.285c0.959,-1.16 1.904,-2.166 2.734,-2.906c12.294,-10.992 34.168,-6.983 44.781,3.795c8.759,8.898 12.229,30.091 10.039,43.188l-6.143,2.726c2.971,-11.583 -1.135,-35.604 -10.071,-40.137c-4.8,-2.437 -9.202,-4.091 -14.535,-2.825c-7.527,1.791 -14.129,7.839 -13.927,15.77c-0.785,1.382 -1.439,2.805 -2.04,4.122c-0.436,0.959 -0.851,1.866 -1.254,2.619c-0.331,0.612 -0.66,1.28 -1.002,1.98c-0.81,1.642 -1.646,3.344 -2.641,4.544c-1.145,1.387 -1.938,1.423 -2.652,1.341c-12.446,-1.469 -10.819,-19.177 -10.744,-19.932z\" fill=\"#ABB8AD\"></path>\r\n     <path id=\"svg_9\" d=\"m78.809,64.922c5.5,-1.942 11.412,-0.24 15.888,2.754c11.278,7.545 12.319,29.426 9.353,41.007l-6.265,2.753c1.192,-6.898 2.421,-24.381 -0.884,-30.169c-2.423,-4.237 -6.689,-7.26 -11.711,-8.294c-5.435,-1.121 -11.047,0.117 -15.389,3.387c-0.827,0.621 -1.609,1.377 -2.327,2.246c-0.748,0.908 -1.388,1.888 -1.956,2.884c-0.202,-7.931 6.056,-13.841 13.291,-16.568z\" fill=\"#73776C\"></path>\r\n    </g>\r\n   </g>\r\n   <g id=\"svg_10\">\r\n    <path id=\"svg_11\" d=\"m88.874,248.517c0,0 -44.701,-44.405 -38.497,-82.423c4.934,-30.226 39.874,-49.665 67.163,-33.799c37.176,21.613 20.389,67.359 20.526,66.607l31.985,14.019c7.202,-30.57 -5.198,-121.423 -95.033,-107.185c-29.481,4.676 -61.531,32.07 -66.11,63.184c-3.954,26.879 2.463,52.538 15.104,75.499c6.106,11.084 18.327,33.943 31.886,30.861c13.294,-3.024 32.976,-26.763 32.976,-26.763z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n    <path id=\"svg_12\" d=\"m28.437,160.023c8.895,-26.57 31.355,-43.293 58.163,-45.798c21.009,-1.926 39.589,2.941 54.538,17.994c20.352,19.347 23.001,48.462 19.815,74.191c1.997,0.601 4.011,1.171 6.053,1.69c4.781,-24.405 -0.75,-49.362 -15.406,-69.053c-17.965,-24.123 -46.33,-35.091 -75.856,-29.356c-26.791,5.204 -58.494,29.589 -62.947,59.866c-3.573,24.289 1.28,48.9 14.571,73.042c1.537,2.789 3.341,5.905 5.499,8.802c0,0.003 0,0.003 0.002,0.001c6.861,9.218 18.686,18.772 25.828,22.032c3.145,-2.896 5.002,-5.579 8.622,-8.218c-30.107,-24.411 -50.8,-65.528 -38.882,-105.193z\" fill=\"#ABB8AD\"></path>\r\n    <path id=\"svg_13\" d=\"m117.542,132.296c7.639,4.445 12.177,8.245 16.466,14.008c12.271,16.478 8.768,33.311 4.055,52.601c6.363,2.452 16.494,5.567 22.889,7.504c3.186,-25.729 0.539,-54.842 -19.815,-74.191c-14.949,-15.053 -33.529,-19.92 -54.538,-17.994c-26.807,2.505 -49.267,19.228 -58.163,45.798c-11.918,39.666 8.777,80.78 38.885,105.19c1.409,-1.03 3.121,-2.366 4.515,-3.362c5.329,-3.808 13.105,-9.474 17.037,-13.334c-2.737,-4.027 -7.349,-10.552 -10.548,-14.902c-14.905,-20.252 -31.995,-39.178 -28.577,-65.944c2.051,-16.04 10.674,-28.537 25.985,-36.093c14.835,-7.321 28.203,-7.189 41.809,0.719z\" fill=\"#73776C\"></path>\r\n   </g>\r\n   <g id=\"svg_14\">\r\n    <g id=\"svg_15\">\r\n     <path id=\"svg_16\" d=\"m23.485,249.275c-0.675,-2.848 -0.245,-5.952 0.059,-8.811c0.728,-6.82 8.392,-26.319 13.737,-31.548l-11.927,-2.737c-3.683,0.425 -16.373,16.119 -17.83,18.905c-4.661,8.907 -5.524,19.76 -3.992,30.234\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_17\" d=\"m23.123,241.446c0.41,-3.819 1.119,-6.655 2.13,-9.83c0.748,-2.354 10.953,-20.744 12.028,-22.699l-11.927,-2.737c-0.833,0.916 -20.409,27.323 -20.388,38.306c0.007,3.152 1.233,7.12 1.334,9.859c5.723,-2.067 11.37,-4.281 17.154,-5.066c-0.966,-3.727 -0.331,-7.833 -0.331,-7.833z\" fill=\"#F8ECCF\"></path>\r\n     <path d=\"m24.363,242.742c-0.171,-4.165 0.896,-8.374 1.517,-12.587c0.276,-1.872 9.148,-21.659 7.229,-22.197c-0.448,-0.128 -3.254,-0.85 -3.254,-0.85s-15.101,33.894 -15.247,42.458c-0.011,0.53 0.052,1.134 0.162,1.793c3.033,-0.975 6.611,-2.17 9.695,-2.546c-0.346,-2.267 -0.008,-3.762 -0.102,-6.071z\" class=\"ring2_1\" id=\"B1_3_\"></path>\r\n    </g>\r\n    <g id=\"B_17_\">\r\n     <path d=\"m91.811,263.656c4.823,-4.546 0.009,-13.988 -5.242,-16.189c-5.983,-2.518 -12.438,0.354 -16.586,4.275c-7.692,7.276 -13.698,21.59 -10.241,33.092c3.934,13.093 14.482,25.055 28.012,24.906c14.266,-0.154 22.022,-8.5 30.246,-20.157c3.665,-5.194 5.881,-10.973 5.394,-17.988c-0.558,-8.002 -6.432,-14.557 -8.735,-22.47c22.827,-20.677 -17.07,-56.542 -37.761,-55.143c-7.922,0.532 -12.788,5.123 -19.063,8.956c-9.405,-5.793 -25.356,-4.495 -32.479,3.241c-5.507,5.98 -11.853,23.961 -6.05,33.572c0.004,0.003 4.473,8.225 9.315,9.213c11.507,2.351 26.738,-14.003 32.211,-14.071c8.755,-0.107 15.175,-0.078 21.077,11.697\" class=\"B5 B6\" id=\"_x35__26_\"></path>\r\n     <path d=\"m90.604,261.885c0.606,-2.255 -2.03,-4.804 -3.384,-6.458c-2.156,-2.64 -4.394,-3.315 -7.497,-3.065c-4.872,0.389 -7.917,4.909 -10.621,8.679c-2.939,4.096 -5.066,7.831 -5.147,13.217c-0.083,5.227 2.538,12.326 5.325,16.757c3.165,5.034 7.25,8.352 12.17,10.813c5.706,2.852 10.859,2.993 16.436,0.702c5.263,-2.162 8.896,-6.534 12.965,-10.705c4.309,-4.417 6.661,-9.379 8.038,-15.644c1.256,-5.728 -1.884,-11.206 -4.383,-16.247c-1.279,-2.587 -6.914,-12.554 -6.478,-15.194c0.478,-2.909 4.662,-4.023 5.353,-6.88c1.429,-5.902 1.648,-17.092 -8.448,-26.84c-4.535,-4.377 -9.183,-7.329 -14.812,-9.392c-5.171,-1.896 -12.079,-4.003 -16.762,-1.068c-2.088,1.305 -4.264,2.716 -6.587,3.673c-1.968,0.81 -4.593,3.058 -6.577,2.914c-1.514,-0.115 -2.98,-1.875 -4.473,-2.433c-9.77,-3.666 -22.759,-1.587 -29.395,6.686c-3.292,4.106 -5.608,9.416 -6.165,14.953c-0.51,5.076 2.013,9.176 5.667,13.094c4.494,4.822 12.184,13.875 26.298,13.672c12.009,-0.172 30.749,-9.444 33.856,-8.103c2.709,1.167 3.826,2.909 5.341,5.598c2.143,3.799 3.297,6.075 2.136,10.404c-0.636,2.354 -3.462,4.562 -2.627,0.607\" class=\"B4\" id=\"_x34__11_\"></path>\r\n     <path d=\"m92.757,252.425c0.705,-2.4 2.164,-3.932 1.601,-6.816c-0.505,-2.597 -2.664,-5.139 -4.128,-7.229c-3.96,-5.649 -8.318,-9.94 -14.693,-11.93c-7.165,-2.238 -14.574,-2.186 -21.352,0.171c-4.872,1.693 -10.098,5.335 -11.205,11.198c1.822,1.344 6.284,-1.939 7.976,-2.604c2.993,-1.185 6.585,-2.002 9.748,-2.344c5.154,-0.562 10.073,0.787 14.365,4.448c2.832,2.419 5.764,5.56 6.84,9.275c3.124,-0.652 7.181,1.87 9.129,4.591c0.024,-0.263 0.221,-0.393 0.287,-0.565\" class=\"B1\" id=\"_x31__6_\"></path>\r\n    </g>\r\n    <g id=\"svg_18\">\r\n     <path id=\"svg_19\" d=\"m32.599,254.571c-4.054,0.256 -9.682,14.587 -10.978,16.888c-6.316,11.238 -2.273,26.541 5.729,38.783c5.783,8.851 14.667,15.327 27.495,17.918c6.744,1.363 17.338,3.222 23.948,1.748c11.244,-2.502 20.413,-7.192 25.067,-15.044c4.218,-7.119 3.105,-18.672 -1.978,-25.95c-7.041,-10.091 -24.511,-14.392 -37.328,-12.247c-4.747,0.793 -11.849,2.722 -14.496,7.597c-2.082,3.838 -3.253,11.239 -1.161,15.364c-1.786,-0.357 -4.745,-4.481 -5.77,-5.906c-2.014,-2.805 -1.824,-5.999 -1.821,-8.901c0.004,-5.71 6.236,-21.884 11.57,-26.132l-20.277,-4.118z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_20\" d=\"m24.002,288.805c1.502,-5.284 12.629,-32.501 13.449,-33.248l15.425,3.132c-0.964,1.612 -10.16,16.786 -10.718,18.743c-0.749,2.64 -1.203,5.005 -1.204,8.203c0,0 -0.31,4.634 2.171,8.086c3.759,5.241 1.419,5.696 4.423,6.302l2.761,0.526c-1.038,-2.05 0.021,-7.178 1.081,-10.901c0.315,-1.11 2.996,-3.061 3.406,-3.824c1.795,-3.302 7.054,-4.812 11.15,-5.5c10.483,-1.755 25.478,1.627 31.432,10.152c3.647,5.223 4.973,13.165 3.228,19.312c-0.36,1.264 -0.845,2.417 -1.436,3.415c-3.707,6.26 -11.143,10.669 -22.1,13.11c-5.283,1.178 -14.415,0.505 -20.707,-0.769c-10.921,-2.208 -21.354,-8.8 -26.577,-16.804c-3.646,-5.57 -7.937,-12.344 -5.784,-19.935z\" fill=\"#F8ECCF\"></path>\r\n    </g>\r\n    <g id=\"svg_21\">\r\n     <path id=\"svg_22\" d=\"m24.961,251.755c-3.73,1.611 -4.195,16.999 -4.634,19.601c-2.161,12.71 6.814,25.75 18.472,34.58c8.43,6.38 18.984,9.478 31.93,7.589c6.809,-0.991 17.407,-2.813 23.133,-6.431c9.74,-6.152 16.789,-13.659 18.522,-22.62c1.565,-8.126 -3.377,-18.626 -10.618,-23.761c-10.035,-7.125 -27.932,-5.279 -39.273,1.063c-4.199,2.35 -10.234,6.561 -11.083,12.044c-0.661,4.314 0.73,11.675 4.093,14.854c-1.801,0.266 -5.981,-2.613 -7.427,-3.612c-2.841,-1.961 -3.739,-5.033 -4.716,-7.767c-1.924,-5.376 -1.515,-22.704 2.075,-28.505l-20.474,2.965z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_23\" d=\"m28.417,286.881c-0.365,-5.48 0.924,-34.859 1.448,-35.835l15.575,-2.256c-0.363,1.845 -3.902,19.231 -3.765,21.263c0.183,2.735 0.557,5.115 1.631,8.127c0,0 1.273,4.464 4.772,6.884c5.307,3.665 3.257,4.883 6.291,4.435l2.776,-0.435c-1.669,-1.58 -2.403,-6.765 -2.661,-10.627c-0.078,-1.15 1.786,-3.889 1.918,-4.75c0.575,-3.711 5.016,-6.912 8.642,-8.937c9.274,-5.188 24.533,-7.066 33.012,-1.049c5.198,3.686 9.122,10.716 9.551,17.09c0.087,1.316 0.022,2.562 -0.196,3.702c-1.381,7.142 -6.892,13.804 -16.385,19.798c-4.572,2.889 -13.397,5.334 -19.75,6.26c-11.023,1.608 -23.071,-1.08 -30.69,-6.848c-5.306,-4.025 -11.634,-8.952 -12.169,-16.822z\" fill=\"#F8ECCF\"></path>\r\n     <path d=\"m90.964,284.894c5.41,2.1 -2.274,7.274 -5.35,10.446c-2.579,2.656 -9.629,6.493 -13.979,7.477c-8.744,1.978 -15.776,1.848 -20.908,-0.079c-4.341,-1.625 -12.962,-7.303 -14.642,-10.679c-3.229,-6.488 -0.637,-37.231 -0.637,-37.231s3.253,-0.443 3.777,-0.505c2.247,-0.269 0.672,17.703 1.124,19.205c1.006,3.383 0.453,6.872 2.279,9.94c1.515,2.537 2.77,5.249 5.359,7.212c4.759,3.618 15.153,8.92 22.525,7.174c4.763,-1.126 18.046,-13.895 20.452,-12.96z\" class=\"ring2_1\" id=\"B1_2_\"></path>\r\n    </g>\r\n    <g id=\"svg_24\">\r\n     <path id=\"svg_25\" d=\"m16.807,269.761c-1.255,3.401 9.351,14.506 10.909,16.607c7.618,10.252 22.611,13.974 36.345,13.1c9.929,-0.631 18.894,-4.865 25.866,-14.055c3.664,-4.836 9.177,-12.563 10.287,-18.588c1.893,-10.243 1.101,-19.81 -4.134,-27.164c-4.75,-6.671 -15.362,-11.052 -23.644,-10.268c-11.482,1.086 -21.663,13.257 -24.448,24.609c-1.032,4.208 -1.921,10.836 1.42,15.207c2.629,3.438 8.736,7.773 13.148,7.969c-0.97,1.279 -5.692,1.794 -7.323,1.968c-3.214,0.348 -5.965,-1.273 -8.526,-2.599c-5.045,-2.615 -17.055,-15.053 -18.86,-21.316l-11.04,14.53z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_26\" d=\"m43.907,292.372c-4.117,-3.628 -24.1,-25.081 -24.457,-26.088l8.399,-11.052c1.068,1.517 11.116,15.902 12.643,17.246c2.057,1.816 3.98,3.263 6.807,4.727c0,0 3.977,2.369 7.934,1.94c6.001,-0.646 5.549,1.455 7.182,-0.697l1.473,-1.995c-2.192,-0.099 -6.336,-3.302 -9.236,-5.858c-0.864,-0.765 -1.609,-3.823 -2.132,-4.51c-2.261,-2.96 -1.676,-7.909 -0.787,-11.538c2.278,-9.285 10.739,-19.875 20.441,-20.798c5.942,-0.562 13.438,1.995 18.232,6.218c0.986,0.877 1.828,1.789 2.495,2.728c4.175,5.862 5.356,13.896 3.508,23.881c-0.885,4.813 -4.817,11.895 -8.232,16.403c-5.94,7.832 -15.574,13.258 -24.547,13.83c-6.256,0.4 -13.805,0.779 -19.723,-4.437z\" fill=\"#F8ECCF\"></path>\r\n     <path d=\"m76.089,256.341c4.106,-0.137 8.348,0.453 10.171,4.379c1.514,3.268 -0.335,10.019 -2.431,13.357c-4.207,6.704 -11.23,10.799 -15.667,13.731c-3.807,2.513 -13.129,6.742 -16.599,5.389c-6.662,-2.599 -28.339,-31.877 -28.339,-31.877s1.778,-2.291 2.067,-2.652c1.25,-1.553 12.972,12.045 14.322,12.833c3.045,1.767 5.16,4.555 8.509,5.604c2.764,0.864 5.492,2.011 8.542,1.822c5.62,-0.351 17.008,-1.055 20.498,-6.76c2.261,-3.69 4.315,-9.305 1.405,-10.663c-2.097,-0.982 -5.592,-5.059 -2.478,-5.163z\" class=\"ring2_1\" id=\"B1_1_\"></path>\r\n    </g>\r\n    <g id=\"svg_27\">\r\n     <path id=\"svg_28\" d=\"m3.535,255.318c0.806,5.524 2.269,10.941 4.218,15.91c4.08,10.396 11.257,17.87 22.474,20.587c5.895,1.43 15.199,3.336 21.338,1.383c10.435,-3.318 19.287,-9.189 24.471,-18.698c4.703,-8.629 3.592,-21.751 -0.846,-29.911c-5.911,-10.873 -17.871,-17.484 -29.679,-14.547c-4.376,1.086 -10.223,3.837 -14.925,8.494c-3.685,3.649 -6.643,7.737 -6.167,12.768c0.184,1.93 1.214,6.418 8.426,14.642\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_29\" d=\"m72.028,272.655c0.663,-1.214 1.24,-2.599 1.727,-4.124c2.352,-7.393 0.795,-15.701 -1.823,-21.831c-4.275,-9.999 -16.873,-15.332 -25.119,-13.296c-3.776,0.932 -9.676,3.227 -13.155,6.053c-3.064,2.489 -5.353,5.978 -5.775,7.311c-2.001,6.285 2.663,14.887 4.958,19.179c-2.933,-1.596 -5.85,-4.98 -8.298,-11.412c-0.223,-0.578 -1.137,-5.565 -1.293,-6.164c-5.782,0.783 -11.242,3.177 -16.966,5.244c0.2,5.589 2.124,11.353 3.851,15.75c3.687,9.398 12.242,16.964 21.793,19.279c5.503,1.334 13.637,1.873 18.541,0.309c10.172,-3.233 17.425,-8.719 21.559,-16.298z\" fill=\"#F8ECCF\"></path>\r\n     <path d=\"m52.502,274.921c6.381,-6.815 6.466,-11.944 3.177,-16.353c-2.105,-2.82 -6.389,-3.66 -9.425,-1.462c-2.529,1.832 0.744,7.922 -6.668,10.325c-6.702,2.17 -12.415,-6.717 -14.902,-12.531c-1.319,-3.093 -0.996,-5.511 -0.65,-6.876c-3.083,0.373 -6.357,1.403 -9.392,2.379c0.817,4.879 4.757,13.71 7.225,16.768c3.312,4.111 9.162,11.077 17.038,12.115c3.917,0.518 10.706,-1.279 13.597,-4.365z\" class=\"ring2_1\" id=\"B1\"></path>\r\n    </g>\r\n   </g>\r\n   <g id=\"B_16_\">\r\n    <path d=\"m115.441,232.578c0.395,43.775 44.804,68.18 73.44,65.435c11.246,-20.871 18.821,-36.797 5.244,-68.13c-4.897,-11.289 -44.357,-37.734 -68.023,-37.224c-8.969,11.353 -10.737,31.644 -10.661,39.919z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__25_\"></path>\r\n    <path d=\"m144.287,204.855c21.002,7.641 40.114,23.373 42.222,27.677c10.954,25.273 6.536,38.252 -3.26,56.839c-53.901,-7.951 -60.881,-67.52 -52.226,-87.786c3.833,0.408 8.35,1.481 13.261,3.268c-0.002,0.005 0.001,0.001 0.003,0.002z\" class=\"B4\" id=\"_x34__10_\"></path>\r\n    <path d=\"m177.457,268.737c5.991,-4.555 1.942,-18.434 -0.077,-23.553c-1.419,-3.596 -9.745,-16.861 -20.068,-13.349c-14.884,5.063 -0.694,26.414 2.33,29.065c4.977,4.371 12.763,11.68 17.815,7.837z\" class=\"B1\" id=\"_x31__5_\"></path>\r\n   </g>\r\n   <g id=\"svg_30\">\r\n    <g id=\"B_14_\">\r\n     <path d=\"m217.553,449.488c-0.241,4.077 4.487,10.401 8.133,12.739c3.072,1.971 10.043,1.853 13.335,0.235l0,0c-3.291,1.618 -10.263,1.736 -13.335,-0.235c-3.646,-2.338 -4.47,-7.613 -4.236,-11.698c0.292,-5.073 3.448,-9.057 7.306,-12.14c6.099,-4.869 15.03,-8.732 22.623,-4.572c3.263,1.786 6.972,5.139 9.352,8.032c2.735,3.321 4.224,10.276 4.836,14.706c0.945,6.806 -3.01,18.364 -6.009,21.954c-4.98,5.963 -10.008,10.971 -18.111,13.353c-5.517,1.622 -20.502,0.101 -27.804,-3.393c-4.948,-2.363 -9.46,-9.109 -12.392,-13.767c-1.172,-1.86 -4.991,-7.042 -5.594,-9.043l18.308,-17.133l3.588,0.962z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__20_\"></path>\r\n     <path d=\"m244.454,434.051c-4.442,-0.037 -9.703,2.114 -14.448,5.902c-4.133,3.301 -6.34,6.899 -6.558,10.694c-0.102,1.759 -0.164,7.666 3.313,9.895c1.096,0.697 3.141,1.13 5.48,1.148c2.318,0.018 5.975,-0.529 7.294,-1.174l-0.515,1.949c-2.343,1.151 -5.266,1.1 -9.085,1.073c-1.58,-0.012 -3.191,-0.632 -4.25,-1.312c-3.724,-2.389 -7.312,-7.651 -8.133,-12.739l-3.029,1.255l-16.458,15.399c0.837,1.542 2.473,3.929 3.448,5.36c0.597,0.873 1.111,1.626 1.43,2.132c2.028,3.226 6.894,10.534 11.552,13.025c5.967,3.204 18.785,5.136 26.455,3.268c7.627,-1.863 12.233,-6.905 17.073,-12.701c2.708,-3.239 6.279,-14.309 5.565,-20.395c-0.935,-7.916 -2.189,-11.022 -4.401,-13.714c-2.464,-2.989 -7.808,-9.299 -14.733,-9.065z\" class=\"B4\" id=\"_x34__5_\"></path>\r\n    </g>\r\n    <g id=\"b\">\r\n     <g id=\"svg_31\">\r\n      <path d=\"m83.252,440.81c2.363,2.463 4.975,6.837 7.411,9.181c3.832,3.687 8.235,7.25 12.545,10.426c10.125,7.459 21.605,12.321 33.707,15.1c8.2,1.873 14.22,1.501 22.275,-0.457c2.902,-0.707 11.627,-5.743 11.627,-5.743s1.483,-0.173 2.652,0.67c4.576,3.302 10.35,4.05 15.832,4.399c4.908,0.317 9.969,-0.312 14.489,-2.324c4.87,-2.163 8.948,-5.309 11.964,-9.594c8.848,-12.572 10.262,-27.351 0.812,-40.252c-2.734,-3.725 -2.97,-9.833 -6.721,-12.565c-2.758,-2.003 -5.718,-3.682 -8.657,-5.391c-4.936,-2.868 -9.798,-5.9 -14.914,-8.442c-2.051,-1.017 -4.368,-1.273 -6.44,-2.235c-1.331,-0.623 -2.579,-1.798 -4.08,-1.019c-1.292,0.671 -1.845,2.638 -2.076,3.947c-1.091,6.144 -5.056,11.477 -7.845,16.934c-1.132,2.218 -2.231,4.563 -3.777,6.517c-1.342,1.697 -3.07,2.34 -4.842,3.448c-4.632,2.894 -9.712,5.225 -15,7.144c-5.312,1.933 -10.688,3.881 -16.159,5.33c-6.086,1.611 -12.201,2.211 -18.49,2.25c-8.236,0.051 -16.654,-0.332 -24.156,-4.155c-1.076,-0.547 -2.115,-1.187 -3.226,-1.654c-0.382,-0.162 -3.662,-0.417 -3.721,-0.496c-0.001,0.002 4.019,6.093 6.79,8.981z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__19_\"></path>\r\n      <path d=\"m176.755,394.31c-0.021,0.003 -0.048,0.014 -0.081,0.032c-0.245,0.13 -0.745,0.922 -1.027,2.517c-0.85,4.817 -3.204,4.837 -5.551,8.929c-0.86,1.503 -2.223,3.808 -2.962,5.251l-1.301,2.41c-1.02,2.019 -1.633,3.737 -3.101,5.591c-1.244,1.576 -1.884,2.293 -3.28,3.072c-0.423,0.238 -1.186,0.657 -1.616,0.926c-4.426,2.762 -9.847,5.42 -15.624,7.517c-5.264,1.913 -9.825,3.648 -15.448,5.138c-1.647,0.438 -3.383,0.872 -5.105,1.183c-4.281,0.771 -9.018,1.231 -14.094,1.256c-7.887,0.051 -15.51,0.24 -23.614,-3.886c-0.387,-0.199 -3.387,-1.713 -3.77,-1.921c-0.066,-0.038 -3.648,-0.461 -3.72,-0.495c1.162,1.584 4.364,6.331 5.448,7.46c1.194,1.245 2.989,3.412 4.175,5.01c1.265,1.714 13.533,10.984 18.31,14.504c9.418,6.941 22.155,12.293 34.612,15.145c6.151,1.408 18.5,-1.204 20.04,-1.577c1.911,-0.467 12.506,-5.78 12.506,-5.78s9.474,4.992 14.721,5.328c2.702,0.175 8.466,0.508 10.922,0.07c2.059,-0.375 4.004,-0.963 5.783,-1.755c4.701,-2.092 9.175,-5.776 11.869,-9.605c8.909,-12.661 8.167,-25.126 -0.211,-36.563c-1.306,-1.779 -1.751,-4.572 -2.491,-6.629c-0.914,-2.534 -1.784,-4.934 -3.478,-6.167c-2.421,-1.759 -5.088,-3.31 -7.667,-4.809l-0.822,-0.474c-1.203,-0.702 -2.4,-1.406 -3.597,-2.116c-3.634,-2.148 -7.389,-4.373 -11.198,-6.261c-0.898,-0.445 -1.911,-0.732 -2.99,-1.042c-1.114,-0.318 -2.262,-0.642 -3.404,-1.175c-0.342,-0.16 -0.682,-0.352 -1.02,-0.543c-0.38,-0.212 -1.021,-0.576 -1.214,-0.541z\" class=\"B4\" id=\"_x34__4_\"></path>\r\n     </g>\r\n     <path d=\"m168.114,458.204c-3.051,1.596 -7.025,3.214 -10.246,3.886c-7.911,1.642 -15.202,3.009 -23.181,1.969c-7.164,-0.927 -14.397,-2.264 -21.398,-4.102c-7.282,-1.906 -14.356,-7.24 -20.702,-11.211c-6.107,-3.819 -11.368,-7.84 -13.3,-15.019c-0.647,-0.32 -1.38,-0.462 -1.888,-0.999c9.531,4.571 19.597,7.959 30.292,7.004c7.13,-0.641 14.334,-1.798 21.354,-3.193c5.017,-0.996 9.391,-2.805 14.054,-4.791c4.958,-2.111 10.343,-3.049 15.216,-5.372c4.91,-2.342 7.739,-6.016 9.48,-11.081c2.982,-8.676 5.151,-21.37 17.037,-20.013c5.797,0.662 13.403,3.96 15.785,9.613c2.1,4.994 2.79,9.153 2.235,13.825c-0.217,1.833 -2.218,6.221 -1.038,7.807c1.396,1.875 3.305,3.309 4.606,5.271c1.436,2.172 2.454,4.583 2.909,7.15c0.885,4.98 -0.173,10.429 -2.699,14.8c-4.667,8.083 -15.964,10.759 -24.673,9.178c-4.761,-0.863 -7.481,-3.741 -9.784,-7.783c-1.145,1.269 -2.535,2.261 -4.059,3.061z\" class=\"B2\" id=\"_x32__15_\"></path>\r\n     <g id=\"svg_32\">\r\n      <path d=\"m216.501,416.474c-1.3,5.533 -5.765,11.181 -10.211,14.961c-4.185,3.558 -12.596,3.921 -16.714,0.758c-2.737,-2.097 -4.648,-6.431 -3.536,-10.92c0.58,3.18 2.281,6.291 4.889,8.103c6.795,3.855 15.119,-0.69 18.167,-6.322c4.941,-12.065 2.734,-29.958 -9.155,-33.914c-9.91,-3.296 -23.494,0.429 -30.296,10.457c-0.501,-0.689 -0.666,-1.726 -0.384,-3.071c0.627,-3.034 3.247,-4.969 5.337,-7.052c4.473,-4.467 11.562,-5.741 17.681,-6.197c6.019,-0.445 13.526,3.62 17.601,7.462c4.044,3.808 8.948,15.83 6.621,25.735z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__17_\"></path>\r\n      <path d=\"m200.92,388.461c10.218,3.601 16.179,22.38 8.635,34.766c-3.055,5.63 -11.144,11.027 -18.915,6.879c-2.609,-1.811 -5.042,-6.3 -4.752,-9.771c0.649,-2.61 2.471,-4.329 5.605,-6.641c0,0 1.979,6.081 4.936,6.733c2.495,0.548 3.948,-3.286 4.618,-5.404c1.078,-3.411 -0.75,-6.969 -2.604,-9.782c-2.687,-4.078 -5.166,-5.906 -9.65,-7.529c-5.587,-2.02 -10.399,1.287 -15.443,2.66c-1.708,0.463 -3.02,0.169 -3.704,-0.774c3.928,-12.058 21.424,-14.613 31.274,-11.137z\" class=\"B4\" id=\"_x34__2_\"></path>\r\n     </g>\r\n     <path d=\"m167.746,376.127c5.368,4.633 8.338,11.374 8.395,19.729c0.059,8.25 -4.888,16.635 -9.802,23.218c-2.925,3.916 -6.976,7.562 -10.966,10.359c-8.673,6.076 -19.986,11.141 -30.366,14.076c-9.944,2.804 -22.071,3.643 -32.021,0.507c-2.607,-0.822 -5.233,-2.002 -7.525,-3.495c-2.599,-1.695 -5.127,-3.952 -7.073,-6.375c-2.408,-2.991 -4.574,-6.369 -6.354,-9.772c-1.422,-2.721 -2.694,-5.527 -3.829,-8.375c-1.393,-3.494 -2.281,-6.662 -2.646,-10.42c-0.173,-1.747 -0.125,-5.958 -2.429,-6.464c3.813,0.838 7.628,14.529 11.911,17.987c3.416,2.76 7.84,3.706 12.127,3.935c4.67,0.244 10.464,-0.12 14.712,-2.241c3.704,-1.85 5.908,-5.5 7.763,-9.043c2.482,-4.737 4.405,-9.741 6.237,-14.756c1.677,-4.596 3.211,-9.515 6.671,-13.125c9.298,-9.711 30.609,-18.343 45.195,-5.745z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__18_\"></path>\r\n     <path d=\"m87.182,443.829c3.464,3.843 9.668,6.204 14.446,8.323c10.98,4.865 21.981,6.243 34.033,6.031c10.296,-0.175 23.06,-4.143 32.519,-8.442c4.116,-1.872 8.626,-5.192 9.734,-9.889c1.856,-7.894 -4.116,-6.293 -7.821,-4.857c-5.127,1.982 -8.436,6.163 -13.532,8.534c-5.569,2.584 -15.768,5.734 -21.865,6.476c-11.748,1.427 -23.359,0.487 -34.109,-5.045c-7.647,-3.931 -22.748,-12.868 -24.123,-13.127c-0.003,-0.002 8.361,9.383 10.718,11.996z\" class=\"B1\" id=\"_x31__3_\"></path>\r\n     <path d=\"m145.198,374.616c-8.902,1.604 -16.358,5.409 -20.139,9.2c-2.553,2.56 -7.153,8.929 -12.16,18.922c-0.957,1.904 -1.848,4.315 -2.894,6.317l-0.363,0.701c-1.866,3.571 -3.07,6.694 -7.762,9.04c-1.935,0.966 -3.013,1.358 -5.504,1.81c-3.696,0.667 -7.73,0.487 -10.349,0.348c-6.674,-0.348 -9.304,-2.833 -12.342,-5.29c-0.819,-0.66 -8.06,-14.413 -10.557,-16.547c0.14,0.699 3.834,13.787 4.387,15.045c1.073,2.462 1.695,6.301 3.069,8.927c1.893,3.624 5.106,7.678 7.08,10.134c1.876,2.334 5.765,5.975 7.796,7.301c1.966,1.279 5.251,2.782 7.527,3.494c6.428,2.028 18.18,2.282 27.04,0.69c1.708,-0.309 7.545,-2.056 9.894,-2.722c10.396,-2.938 17.243,-6.797 25.454,-12.55c4.059,-2.846 6.932,-6.664 9.384,-9.949c6.105,-8.172 7.426,-17.779 7.386,-23.599c-0.05,-7.045 -2.402,-12.62 -6.984,-16.579c-5.268,-4.554 -11.98,-6.129 -19.963,-4.693z\" class=\"B4\" id=\"_x34__3_\"></path>\r\n     <path d=\"m142.615,383.889c-6.573,1.186 -10.64,7.781 -13.558,10.826c-1.417,1.481 -5.977,15.276 -8.781,20.626c-1.773,3.385 -5.46,10.415 -13.031,14.197c-2.585,1.29 -5.719,1.663 -8.842,2.838c-3.596,1.349 -22.861,-4.971 -25.948,-6.144c0,0 3.402,5.158 5.207,6.99c7.974,11.691 26.165,15.207 35.683,13.2c1.753,-0.367 11.199,-1.928 12.899,-2.333c11.852,-2.802 22.114,-8.156 30.41,-14.125c3.276,-2.357 4.8,-9.675 6.421,-13.475c3.35,-7.866 2.666,-17.789 2.284,-20.482c-0.702,-4.954 -2.625,-8.231 -5.429,-10.647c-3.39,-2.935 -11.75,-2.473 -17.315,-1.471z\" class=\"B2\" id=\"_x32__14_\"></path>\r\n    </g>\r\n    <g id=\"svg_33\">\r\n     <path id=\"svg_34\" d=\"m113.244,409.994c-0.724,-2.87 1.247,-7.957 4.269,-8.438c7.172,-1.148 16.498,17.498 6.792,27.522c-4.177,4.317 -11.01,1.844 -12.941,5.289c-1.264,2.244 -4.097,5.084 -9.111,6.158c-11.498,2.454 -22.094,-5.787 -29.247,-14.301c-16.989,-20.224 -16.668,-53.739 -2.283,-75.187c5.191,-7.74 11.568,-13.619 18.85,-19.302c10.032,-7.825 55.451,-24.199 65.724,-24.985c12.025,-0.916 47.964,-0.984 59.805,1.083c12.413,2.167 35.688,17.619 42.374,30.119c0.575,1.078 -20.25,1.908 -27.539,1.972c-7.126,0.061 -14.23,-0.853 -21.36,-0.885c-11.83,-0.054 -23.471,2.526 -34.58,6.476c-6.242,2.217 -12.321,4.875 -18.264,7.792c-6.501,3.192 -10.459,7.682 -13.9,13.978c-1.964,3.596 -5.624,3.395 -9.201,4.966c-6.895,3.033 -13.267,7.751 -17.18,14.254c-4.419,7.336 -4.241,15.428 -2.208,23.489z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E5DFDE\"></path>\r\n     <path id=\"svg_35\" d=\"m153.445,309.024c-12.854,2.315 -53.333,17.024 -62.644,24.29c-8.504,6.634 -14.013,12.268 -18.419,18.835c-14.439,21.533 -13.474,54.184 2.154,72.789c5.055,6.019 15.252,15.808 26.722,13.741c0.19,-0.035 0.384,-0.069 0.575,-0.112c4.998,-1.07 7.109,-3.978 7.784,-5.18c1.152,-2.053 3.221,-2.765 5.123,-3.018c3.32,-0.44 6.779,-1.288 8.128,-2.684c4.942,-5.103 4.226,-13.005 1.326,-18.572c-1.836,-3.531 -4.514,-5.875 -6.367,-5.58c-0.514,0.093 -1.088,0.586 -1.583,1.36c-1,1.55 -2.355,7.991 -2.355,7.991s-2.291,-1.755 -2.768,-2.569c-5.052,-8.687 -1.527,-17.96 2.618,-24.845c4.804,-7.978 12.489,-12.59 18.086,-15.047c1.177,-0.519 2.354,-0.862 3.391,-1.165c2.475,-0.717 3.921,-1.21 4.863,-2.935c3.96,-7.243 8.38,-11.676 14.767,-14.814c6.533,-3.202 12.579,-5.781 18.484,-7.88c6.479,-2.302 12.822,-4.02 18.848,-5.107c5.598,-1.008 11.119,-1.506 16.408,-1.484c3.442,0.016 6.905,0.238 10.255,0.445c3.639,0.231 7.406,0.474 11.082,0.439c5.866,-0.05 18.825,-0.545 24.426,-1.218c-8.066,-11.513 -31.546,-25.521 -39.585,-26.9c-11.875,-2.036 -53.759,-2.142 -61.319,-0.78z\" fill=\"#D9E0D1\"></path>\r\n     <path id=\"svg_36\" d=\"m91.32,425.481c1.954,0.427 6.15,-0.472 7.876,-1.423c3.742,-2.058 3.845,-5.647 2.208,-9.188c-1.669,-3.612 -3.581,-7.05 -3.841,-11.098c-1.018,-15.803 9.22,-29.972 20.021,-40.42c3.186,-3.083 6.716,-6.159 10.466,-8.547c12.03,-7.661 23.226,-17.271 37.124,-21.427c6.225,-1.861 12.263,-4.422 18.625,-5.734c30.354,-6.26 50.506,6.41 52.92,2.216c2.086,-3.629 -1.63,-10.316 -4.495,-12.752c-1.128,-0.959 -8.306,-5.112 -18.475,-7.463c-9.292,-2.145 -21.271,-2.57 -29.535,-2.165c-2.851,0.136 -20.129,0.552 -25.863,1.065c-16.558,1.487 -32.277,9.43 -46.375,18.128c-3.997,2.469 -8.306,4.633 -11.615,7.965c-9.438,9.496 -16.341,19.579 -20.969,33.029c-1.184,3.443 -2.317,8.677 -2.526,12.31c-0.277,4.824 -0.566,11.458 0.047,16.25c0.911,7.101 3.982,13.644 6.707,20.3c0.592,1.449 1.525,2.735 2.379,3.942c0,0.002 3.384,4.591 5.321,5.012z\" fill=\"#9CB098\"></path>\r\n     <path id=\"svg_37\" d=\"m91.674,416.424c-15.735,-30.695 5.149,-59.615 32.289,-76.087c7.287,-4.426 18.983,-10.185 24.728,-13.598c7.009,-4.162 18.913,-8.53 18.5,-9.641c-0.427,-1.158 -20.319,5.068 -24.317,6.244c-7.418,2.178 -14.397,5.642 -21.103,9.764c-13.622,8.375 -26.315,17.018 -33.765,32.019c-3.972,8.001 -5.997,18.185 -6.041,26.863c-0.026,4.656 1.198,10.332 2.652,14.736c1.09,3.29 4.958,12.263 6.761,11.271c0.423,-0.228 0.296,-1.571 0.296,-1.571z\" fill=\"#8A7C74\"></path>\r\n    </g>\r\n    <g id=\"svg_38\">\r\n     <path id=\"svg_39\" d=\"m161.871,306.583c-4.353,-4.406 -17.091,-7.431 -23.2,-7.509c-13.588,-0.173 -23.123,0.042 -32.859,10.325c-2.89,3.05 -8.078,12.608 -9.731,16.484c-4.02,9.431 -4.473,24.239 2.992,31.637c3.852,3.819 5.907,8.463 11.639,8.036c4.477,-0.34 10.691,-6.188 13.048,-10.107c3.197,-5.319 4.395,-10.575 3.621,-16.575c-0.625,-4.825 -1.52,-7.511 -6.825,-10.623c-2.329,-1.369 -6.166,0.907 -8.138,2.523c-1.588,1.299 -4.651,4.112 -4.989,0.697c-1.091,-10.961 11.97,-15.765 20.231,-18.634c9.135,-3.172 18.672,-6.43 28.456,-6.441c1.899,0.001 5.755,0.187 5.755,0.187z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E5DFDE\"></path>\r\n     <path id=\"svg_40\" d=\"m123.368,301.811c-6.348,1.143 -11.315,3.906 -16.101,8.96c-2.699,2.853 -7.744,12.145 -9.346,15.896c-3.876,9.094 -4.001,22.931 2.56,29.434c0.977,0.967 1.819,1.958 2.631,2.914c2.617,3.067 4.251,4.788 7.45,4.547c0.142,-0.012 0.285,-0.032 0.428,-0.055c3.535,-0.638 8.845,-5.408 11.058,-9.09c2.988,-4.975 4.054,-9.832 3.349,-15.283c-0.566,-4.399 -1.259,-6.459 -5.852,-9.157c-0.336,-0.195 -0.859,-0.157 -1.237,-0.089c-1.56,0.28 -3.466,1.488 -4.629,2.437l-0.331,0.276c-1.433,1.191 -2.731,2.193 -4.118,2.442c-1.144,0.208 -1.947,-0.175 -2.418,-0.531c-0.784,-0.592 4.69,-7.84 5.828,-8.475c9.049,-5.031 12.436,-7.175 20.415,-9.945c5.949,-2.067 8.242,-3.006 15.11,-4.245c0,0 7.238,-3.202 7.733,-3.122c2.142,0.343 -0.745,-2.207 1.707,-2.303c-2.308,-3.65 -15.035,-5.295 -18.961,-5.345c-5.919,-0.076 -10.8,-0.072 -15.276,0.734z\" fill=\"#D9E0D1\"></path>\r\n    </g>\r\n   </g>\r\n   <g id=\"svg_41\">\r\n    <g id=\"B_15_\">\r\n     <path d=\"m349.804,189.015l-6.046,-24.336c1.593,-1.35 7.618,-3.622 9.611,-4.548c4.994,-2.311 12.45,-5.518 17.888,-4.812c8.028,1.039 21.43,7.913 25.178,12.275c5.505,6.405 7.002,13.342 7.937,21.053c0.563,4.644 -2.406,16.495 -6.898,21.694c-2.923,3.386 -7.955,8.411 -12.055,9.712c-3.573,1.13 -8.506,1.93 -12.217,1.65c-8.634,-0.633 -14.027,-8.736 -16.499,-16.136c-1.56,-4.684 -2.042,-9.744 0.472,-14.16c2.025,-3.559 5.587,-7.535 9.916,-7.513c3.65,0.016 9.436,3.904 11.318,7.055l0,0c-1.881,-3.15 -7.668,-7.039 -11.318,-7.055c-4.33,-0.022 -11.737,2.713 -13.753,6.266l-3.534,-1.145z\" class=\"B5 B6\" id=\"_x35__24_\"></path>\r\n     <path d=\"m384.814,218.147c3.321,-1.059 6.061,-2.982 11.151,-9.114c3.909,-4.719 6.934,-15.951 6.423,-20.141c-0.91,-7.496 -2.035,-14.233 -7.42,-19.944c-5.422,-5.738 -17.23,-11.088 -23.979,-11.645c-5.264,-0.442 -13.322,3.042 -16.778,4.646c-0.543,0.253 -1.385,0.607 -2.36,1.015c-1.597,0.671 -4.268,1.783 -5.808,2.622l5.435,21.874l1.859,2.699c3.457,-3.823 9.329,-6.287 13.753,-6.266c1.259,0.003 2.949,0.36 4.281,1.207c3.218,2.059 5.699,3.604 7.039,5.843l-0.626,1.917c-0.757,-1.258 -3.528,-3.706 -5.484,-4.953c-1.973,-1.26 -3.924,-2.006 -5.223,-2.016c-4.131,-0.02 -7.291,4.966 -8.162,6.501c-1.88,3.301 -1.986,7.525 -0.313,12.541c1.922,5.759 5.166,10.424 8.915,12.807c5.685,3.962 13.601,1.574 17.297,0.407z\" class=\"B4\" id=\"_x34__9_\"></path>\r\n    </g>\r\n    <g id=\"b_1_\">\r\n     <g id=\"svg_42\">\r\n      <path d=\"m225.331,128.242c0.092,-0.033 2.982,1.537 3.392,1.608c1.187,0.213 2.405,0.238 3.605,0.367c8.376,0.869 15.648,5.126 22.531,9.649c5.258,3.454 10.062,7.281 14.294,11.946c3.803,4.192 7.255,8.748 10.662,13.26c3.394,4.487 6.39,9.205 8.703,14.151c0.884,1.894 1.984,3.376 2.188,5.529c0.234,2.483 -0.119,5.048 -0.375,7.523c-0.628,6.098 -0.201,12.728 -2.626,18.476c-0.519,1.228 -1.124,3.178 -0.405,4.445c0.837,1.47 2.522,1.162 3.98,1.36c2.262,0.319 4.344,1.367 6.618,1.628c5.676,0.65 11.404,0.751 17.107,1.028c3.396,0.161 6.793,0.363 10.196,0.182c4.634,-0.25 8.154,-5.247 12.475,-6.887c14.945,-5.686 21.797,-18.861 21.209,-34.22c-0.2,-5.236 -1.913,-10.094 -4.823,-14.557c-2.698,-4.146 -6.603,-7.427 -10.894,-9.831c-4.791,-2.69 -10.042,-5.201 -15.678,-4.918c-1.442,0.07 -2.591,-0.88 -2.591,-0.88s-4.583,-8.972 -6.634,-11.143c-5.694,-6.023 -10.543,-9.613 -18.444,-12.499c-11.666,-4.251 -23.944,-6.411 -36.498,-5.658c-5.345,0.321 -10.977,0.917 -16.198,1.926c-3.319,0.643 -7.89,2.893 -11.213,3.672c-3.892,0.917 -10.579,3.845 -10.581,3.843z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__23_\"></path>\r\n      <path d=\"m290.406,214.482c0.388,0.025 0.778,0.047 1.151,0.097c1.248,0.176 2.388,0.528 3.495,0.867c1.075,0.325 2.08,0.637 3.077,0.751c4.223,0.486 8.584,0.663 12.801,0.836c1.391,0.056 2.779,0.116 4.169,0.181l0.947,0.049c2.98,0.144 6.062,0.292 9.05,0.134c2.092,-0.113 4.126,-1.653 6.273,-3.285c1.739,-1.323 3.631,-3.425 5.694,-4.208c13.251,-5.041 20.653,-15.097 20.062,-30.57c-0.179,-4.68 -1.929,-10.203 -4.737,-14.513c-1.061,-1.635 -2.374,-3.184 -3.898,-4.62c-1.822,-1.703 -6.841,-4.558 -9.204,-5.88c-4.585,-2.574 -15.251,-3.534 -15.251,-3.534s-6,-10.222 -7.35,-11.655c-1.089,-1.148 -10.032,-10.056 -15.96,-12.222c-12.005,-4.379 -25.605,-6.814 -37.283,-6.111c-5.923,0.355 -21.26,1.464 -23.253,2.213c-1.865,0.694 -4.55,1.54 -6.229,1.936c-1.522,0.356 -6.793,2.6 -8.628,3.297c0.079,0.009 3.315,1.6 3.391,1.607c0.434,0.03 3.774,0.393 4.208,0.438c9.045,0.942 15.339,5.25 21.929,9.582c4.247,2.782 7.973,5.744 11.144,8.72c1.277,1.197 2.497,2.506 3.641,3.769c3.91,4.308 6.793,8.244 10.17,12.713c3.707,4.901 6.81,10.081 9.023,14.806c0.215,0.458 0.628,1.225 0.853,1.654c0.748,1.411 0.896,2.364 1.082,4.362c0.223,2.354 -0.198,4.13 -0.44,6.377l-0.218,2.729c-0.166,1.616 -0.276,4.291 -0.37,6.019c-0.257,4.712 1.708,6.005 -0.198,10.513c-0.63,1.491 -0.642,2.428 -0.507,2.671c0.018,0.034 0.034,0.058 0.051,0.07c0.144,0.135 0.88,0.176 1.315,0.207z\" class=\"B4\" id=\"_x34__8_\"></path>\r\n     </g>\r\n     <path d=\"m318.332,160.737c4.131,-2.139 7.979,-3.079 12.444,-1.214c8.169,3.412 16.194,11.799 15.715,21.119c-0.26,5.045 -2.334,10.193 -5.784,13.888c-1.779,1.91 -3.944,3.38 -6.33,4.418c-2.16,0.939 -4.542,1.108 -6.734,1.921c-1.852,0.689 -2.56,5.457 -3.374,7.115c-2.075,4.223 -4.917,7.338 -9.396,10.387c-5.073,3.447 -13.249,2.077 -18.474,-0.517c-10.712,-5.33 -5.629,-17.161 -3.414,-26.063c1.293,-5.197 0.918,-9.82 -1.929,-14.455c-2.826,-4.598 -6.836,-8.314 -9.848,-12.782c-2.832,-4.204 -5.52,-8.101 -9.188,-11.667c-5.132,-4.985 -10.548,-9.877 -16.183,-14.293c-8.456,-6.616 -18.745,-9.248 -29.229,-10.594c0.718,-0.174 1.41,0.103 2.127,0.188c5.525,-4.974 12.127,-5.487 19.328,-5.369c7.486,0.115 16.322,-0.513 23.47,1.849c6.875,2.264 13.673,5.076 20.188,8.194c7.261,3.468 12.637,8.578 18.382,14.26c2.337,2.315 4.793,5.835 6.485,8.834c0.846,1.5 1.473,3.089 1.744,4.781z\" class=\"B2\" id=\"_x32__17_\"></path>\r\n     <g id=\"svg_43\">\r\n      <path d=\"m314.949,235.287c-5.51,1.005 -14.019,0.333 -18.829,-3.311c-4.886,-3.711 -10.143,-8.635 -11.468,-14.816c-0.62,-2.889 -1.767,-5.933 -0.642,-8.824c0.493,-1.28 1.196,-2.06 1.991,-2.366c0.254,12.115 9.627,22.627 19.737,25.252c12.128,3.142 23.711,-10.672 26.127,-23.484c0.504,-6.384 -4.009,-14.723 -11.807,-15.185c-3.173,0.106 -6.293,1.79 -8.509,4.144c1.507,-4.375 5.469,-6.971 8.905,-7.24c5.177,-0.416 12.038,4.46 13.614,9.723c1.676,5.59 2.352,12.759 0.434,18.11c-3.435,9.578 -14.088,16.999 -19.553,17.997z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__22_\"></path>\r\n      <path d=\"m286.003,205.972c1.088,-0.42 2.347,0.045 3.53,1.364c3.486,3.895 5.725,9.286 11.512,10.632c4.646,1.076 7.721,0.887 12.193,-1.072c3.086,-1.35 6.555,-3.343 7.505,-6.792c0.589,-2.14 1.454,-6.149 -0.937,-7.048c-2.835,-1.06 -7.803,2.965 -7.803,2.965c-1.373,-3.642 -1.967,-6.075 -1.091,-8.618c1.643,-3.074 6.126,-5.514 9.301,-5.615c8.777,0.745 12.63,9.672 12.131,16.06c-0.405,14.495 -15.621,27.015 -26.153,24.48c-10.157,-2.444 -23.449,-14.105 -20.188,-26.356z\" class=\"B4\" id=\"_x34__7_\"></path>\r\n     </g>\r\n     <path d=\"m236.84,195.234c-0.94,-4.915 0.447,-9.874 1.54,-14.642c1.19,-5.205 2.297,-10.449 2.791,-15.774c0.371,-3.983 0.506,-8.246 -1.597,-11.81c-2.411,-4.093 -7.076,-7.549 -11.127,-9.882c-3.722,-2.14 -7.949,-3.752 -12.318,-3.294c-5.474,0.572 -16.122,9.989 -19.777,8.617c2.21,0.83 4.459,-2.729 5.554,-4.104c2.349,-2.952 4.819,-5.129 7.888,-7.306c2.502,-1.77 5.094,-3.432 7.767,-4.942c3.345,-1.887 7,-3.546 10.648,-4.746c2.949,-0.974 6.299,-1.496 9.402,-1.505c2.736,-0.006 5.581,0.43 8.216,1.16c10.054,2.782 19.775,10.081 26.595,17.838c7.114,8.111 13.853,18.515 17.827,28.329c1.828,4.515 3.243,9.781 3.568,14.657c0.543,8.197 0.135,17.921 -4.401,24.813c-4.591,6.982 -10.749,11.023 -17.774,11.99c-19.09,2.639 -32.279,-16.193 -34.802,-29.399z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__21_\"></path>\r\n     <path d=\"m225.337,128.243c1.295,0.53 18.828,1.244 27.383,2.104c12.03,1.205 22.286,6.726 31.368,14.315c4.713,3.938 11.56,12.131 14.828,17.324c2.987,4.763 3.489,10.073 6.715,14.523c2.328,3.22 6.467,7.812 9.204,0.176c1.626,-4.542 -0.356,-9.783 -2.791,-13.591c-5.6,-8.751 -14.154,-19.026 -22.699,-24.77c-9.997,-6.732 -19.98,-11.558 -31.839,-13.448c-5.161,-0.82 -11.654,-2.212 -16.649,-0.871c-3.401,0.912 -15.524,4.239 -15.52,4.238z\" class=\"B1\" id=\"_x31__4_\"></path>\r\n     <path d=\"m271.204,220.561c6,-0.831 11.006,-4.23 14.878,-10.117c3.2,-4.863 7.316,-13.643 6.638,-23.821c-0.272,-4.09 -0.607,-8.853 -2.464,-13.45c-3.763,-9.293 -7.41,-16.256 -14.536,-24.376c-1.609,-1.836 -5.556,-6.476 -6.822,-7.664c-6.569,-6.156 -16.57,-12.332 -23.067,-14.126c-2.298,-0.64 -5.872,-1.166 -8.217,-1.161c-2.426,0.007 -7.669,0.945 -10.513,1.887c-2.991,0.986 -7.892,2.641 -11.452,4.653c-2.581,1.456 -5.192,4.34 -7.431,5.822c-1.146,0.755 -11.365,9.729 -11.861,10.239c3.255,-0.433 16.811,-8.037 17.856,-8.144c3.885,-0.411 7.445,-1.068 13.234,2.273c2.273,1.308 5.757,3.351 8.496,5.917c1.844,1.737 2.536,2.652 3.635,4.514c2.66,4.521 1.973,7.795 1.596,11.807l-0.076,0.787c-0.21,2.248 -0.775,4.757 -1.006,6.875c-1.234,11.11 -0.837,18.956 -0.087,22.492c1.111,5.238 5.299,12.486 11.898,18.672c5.915,5.547 12.404,7.875 19.301,6.921z\" class=\"B4\" id=\"_x34__6_\"></path>\r\n     <path d=\"m270.105,212.638c3.668,-0.503 7.063,-2.208 10.346,-5.982c1.787,-2.052 7.756,-10.008 9.223,-18.431c0.706,-4.073 3.407,-11.041 1.939,-14.8c-3.715,-9.521 -9.414,-19.595 -17.837,-28.391c-1.206,-1.266 -8.285,-7.712 -9.556,-8.974c-6.896,-6.863 -24.073,-13.806 -37.123,-8.33c-2.51,0.556 -8.17,3.034 -8.17,3.034c3.228,0.695 22.833,5.866 25.116,8.957c1.983,2.683 4.41,4.698 5.877,7.188c4.296,7.293 3.567,15.197 3.215,19.001c-0.558,6.016 -4.233,20.073 -3.85,22.086c0.794,4.141 0.62,11.885 5.491,16.458c4.125,3.866 10.889,8.801 15.329,8.184z\" class=\"B2\" id=\"_x32__16_\"></path>\r\n    </g>\r\n    <g id=\"svg_44\">\r\n     <path id=\"svg_45\" d=\"m233.401,187.487c-0.253,7.587 2.528,15.009 6.665,21.306c2.148,3.262 5.328,5.082 5.02,9.168c-0.536,7.156 0.344,13.074 4.064,19.289c3.4,5.682 7.056,11.219 11.089,16.471c7.174,9.357 15.54,17.852 25.497,24.244c6.001,3.848 12.461,6.946 18.406,10.871c6.083,4.019 23.107,16.039 22.039,16.634c-12.409,6.852 -40.345,7.16 -51.94,2.23c-11.061,-4.707 -41.183,-24.307 -50.776,-31.619c-8.195,-6.246 -37.405,-44.688 -41.568,-56.708c-3.021,-8.729 -5.174,-17.131 -5.321,-26.451c-0.407,-25.822 17.55,-54.123 42.805,-61.852c10.634,-3.255 24.008,-4.408 32.322,3.905c3.624,3.627 4.457,7.552 4.298,10.122c-0.253,3.942 6.825,5.583 7.983,11.476c2.694,13.692 -15.272,24.266 -20.666,19.403c-2.275,-2.046 -1.163,-7.389 1.007,-9.403c-6.091,5.66 -10.641,12.352 -10.924,20.914z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E5DFDE\"></path>\r\n     <path id=\"svg_46\" d=\"m275.031,305.861c7.495,3.217 34.819,4.23 47.849,-1.043c-4.334,-3.61 -14.939,-11.075 -19.835,-14.31c-3.067,-2.025 -6.36,-3.872 -9.539,-5.658c-2.924,-1.646 -5.951,-3.346 -8.848,-5.202c-4.449,-2.857 -8.813,-6.279 -12.962,-10.169c-4.464,-4.187 -8.854,-9.078 -13.039,-14.534c-3.814,-4.975 -7.485,-10.427 -11.226,-16.666c-3.654,-6.11 -4.953,-12.232 -4.336,-20.465c0.147,-1.956 -0.797,-3.156 -2.485,-5.106c-0.705,-0.816 -1.505,-1.745 -2.211,-2.821c-3.361,-5.106 -7.303,-13.155 -6.995,-22.463c0.267,-8.033 2.351,-17.73 11.315,-22.276c0.842,-0.42 3.718,-0.647 3.718,-0.647s-2.365,6.142 -2.369,7.984c-0.004,0.921 0.208,1.645 0.589,2.003c1.394,1.254 4.916,0.743 8.378,-1.219c5.46,-3.094 10.357,-9.338 8.987,-16.307c-0.374,-1.904 -2.815,-4.497 -5.361,-6.673c-1.459,-1.247 -2.808,-2.97 -2.657,-5.319c0.087,-1.375 -0.104,-4.965 -3.716,-8.58c-0.138,-0.139 -0.282,-0.274 -0.422,-0.408c-8.501,-7.971 -22.381,-5.303 -29.897,-3.003c-23.232,7.117 -41.799,33.989 -41.393,59.915c0.126,7.904 1.685,15.631 5.213,25.823c3.861,11.158 29.831,45.517 39.359,54.452c5.605,5.255 40.81,27.941 51.883,32.692z\" fill=\"#D9E0D1\"></path>\r\n     <path id=\"svg_47\" d=\"m227.159,142.962c-1.372,0.55 -2.855,1.121 -4.141,2.017c-5.905,4.101 -12.041,7.922 -16.667,13.387c-3.12,3.689 -6.485,9.412 -8.876,13.612c-1.8,3.16 -3.697,8.17 -4.576,11.704c-3.43,13.805 -3.122,26.02 -0.366,39.122c0.964,4.594 3.404,8.752 5.414,12.998c7.101,14.969 15.972,30.184 29.059,40.434c4.535,3.55 18.807,13.293 21.126,14.961c6.715,4.835 16.998,10.993 25.962,14.247c9.812,3.558 18.095,3.975 19.563,3.782c3.73,-0.488 10.486,-4.075 10.707,-8.255c0.257,-4.833 -23.546,-5.162 -45.614,-26.924c-4.625,-4.56 -8.3,-9.994 -12.512,-14.938c-9.402,-11.049 -13.571,-25.199 -19.5,-38.171c-1.848,-4.044 -3.137,-8.547 -4.135,-12.863c-3.382,-14.643 -4.269,-32.103 5.181,-44.81c2.42,-3.254 5.893,-5.1 9.26,-7.224c3.298,-2.081 5.163,-5.151 3.143,-8.91c-0.932,-1.741 -3.964,-4.776 -5.836,-5.479c-1.857,-0.7 -7.192,1.31 -7.192,1.31z\" fill=\"#9CB098\"></path>\r\n     <path id=\"svg_48\" d=\"m230.326,147.964c-0.974,-1.81 -9.098,3.616 -11.802,5.785c-3.615,2.905 -7.728,7.002 -10.239,10.924c-4.683,7.305 -8.521,16.952 -9.54,25.827c-1.907,16.641 4.043,30.798 10.92,45.234c3.386,7.103 7.359,13.809 12.4,19.67c2.715,3.162 16.022,19.204 17.01,18.464c0.952,-0.706 -6.663,-10.847 -10.281,-18.151c-2.965,-5.989 -9.649,-17.182 -13.356,-24.862c-13.816,-28.581 -15.615,-64.21 14.283,-81.408c0,0 0.837,-1.058 0.605,-1.483z\" fill=\"#8A7C74\"></path>\r\n    </g>\r\n    <g id=\"svg_49\">\r\n     <path id=\"svg_50\" d=\"m223.963,276.824c-8.206,-5.33 -14.436,-13.251 -20.377,-20.878c-5.374,-6.903 -13.722,-18.036 -6.845,-26.639c2.142,-2.683 3.181,1.343 3.808,3.295c0.776,2.429 2.759,6.425 5.459,6.544c6.144,0.276 8.356,-1.495 11.504,-5.204c3.913,-4.61 5.765,-9.674 5.975,-15.876c0.154,-4.575 -1.881,-12.859 -5.453,-15.578c-4.579,-3.476 -8.829,-0.698 -14.137,0.413c-10.288,2.149 -17.961,14.824 -19.718,24.921c-0.72,4.151 -1.565,14.996 -0.797,19.124c2.577,13.924 10.462,19.291 21.959,26.538c5.169,3.254 17.504,7.645 23.553,6.312c-0.002,0 -3.339,-1.936 -4.931,-2.972z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E5DFDE\"></path>\r\n     <path id=\"svg_51\" d=\"m206.405,271.788c3.322,2.095 14.897,7.633 18.819,5.828c-2.007,-1.414 1.803,-1.983 -0.181,-2.861c-0.458,-0.202 -4.791,-6.824 -4.791,-6.824c-5.09,-4.776 -6.502,-6.811 -10.372,-11.781c-5.189,-6.663 -6.865,-10.305 -11.722,-19.448c-0.611,-1.152 -1.263,-10.21 -0.282,-10.281c0.589,-0.044 1.47,0.071 2.318,0.869c1.028,0.962 1.573,2.51 2.128,4.289l0.128,0.41c0.459,1.432 1.402,3.479 2.56,4.566c0.28,0.26 0.699,0.576 1.086,0.596c5.321,0.233 7.024,-1.119 9.891,-4.499c3.557,-4.192 5.304,-8.848 5.501,-14.648c0.144,-4.292 -1.717,-11.185 -4.337,-13.641c-0.107,-0.099 -0.216,-0.196 -0.328,-0.283c-2.553,-1.939 -4.862,-1.383 -8.725,-0.233c-1.201,0.362 -2.448,0.734 -3.793,1.016c-9.041,1.887 -16.461,13.567 -18.156,23.305c-0.695,4.018 -1.515,14.564 -0.801,18.424c1.267,6.843 3.932,11.862 8.638,16.275c3.318,3.107 7.412,5.767 12.419,8.921z\" fill=\"#D9E0D1\"></path>\r\n    </g>\r\n   </g>\r\n   <g id=\"ring2\">\r\n    <path d=\"m207.432,294.866c-3.357,6.176 -18.615,9.827 -25.758,6.647c-4.772,-2.124 -15.227,-7.524 -17.056,-12.206c-2.051,-5.242 2.088,-12.817 6.809,-12.581c-1.015,-5.268 3.582,-15.932 17.525,-11.806c10.19,3.018 22.388,22.753 18.48,29.946z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__16_\"></path>\r\n    <path id=\"svg_52\" d=\"m168.737,288.499c-0.261,-0.352 -0.361,-0.569 -0.392,-0.643c-0.61,-1.571 -0.249,-4.07 1.126,-5.741c2.231,-2.712 6.847,-1.138 6.847,-1.138l-0.963,-5.004c-0.305,-1.592 0.791,-5.754 3.499,-7.779c0.788,-0.586 3.159,-2.36 8.259,0.28c1.528,0.79 9.852,5.824 14.149,11.599c5.955,7.996 3.146,11.981 2.65,12.887c-2.118,3.902 -14.799,7.49 -20.609,4.9c-5.475,-2.44 -12.365,-6.405 -14.566,-9.361z\" fill=\"#F8ECCF\"></path>\r\n   </g>\r\n   <g id=\"SIDE\">\r\n    <path id=\"svg_53\" d=\"m233.678,285.61c4.568,-0.933 9.047,-1.453 12.016,-2.014c6.016,-1.139 12.073,-2.032 18.11,-3.059c9.001,-1.539 18.276,-3.374 27.419,-1.989c13.206,2.008 26.051,11.69 36.853,19.211c7.543,5.251 15.26,10.574 22.03,16.805c9.403,8.658 25.059,23.106 17.751,37.213c-3.927,7.587 -10.234,14.295 -17.805,18.273c-8.504,4.462 -18.204,2.46 -27.04,0.234c-17.873,-4.494 -36.882,-4.562 -54.906,-8.965c-11.192,-2.733 -21.667,-7.854 -29.532,-16.431c-6.735,-7.342 -10.519,-16.898 -14.385,-25.936c-2.862,-6.678 -9.429,-15.773 -7.606,-23.355c1.619,-6.741 11.368,-8.819 17.095,-9.987z\" fill=\"rgb(206, 213, 208)\"></path>\r\n    <g id=\"SIDE_2_\">\r\n     <path d=\"m346.316,244.947c-20.917,-11.699 -46.445,-13.184 -69.03,-4.179c-7.083,2.825 -14.165,6.925 -20.293,11.45c-6.788,5.007 -13.112,10.604 -19.62,15.96c-4.401,3.619 -10.994,12.016 -17.179,6.892c-6.766,-5.607 1.309,-12.95 0.541,-19.352c-1.987,-16.593 -23.516,-19.174 -32.363,-5.632c-6.421,9.826 12.064,40.806 24.063,44.573c12.268,3.85 24.734,-0.621 36.613,-4.661c10.521,-3.578 23.531,-6.46 35.278,-3.407c19.31,5.015 27.754,7.482 42.117,23.084c9.39,10.194 27.699,25.694 38.872,33.876c6.541,4.791 14.056,8.404 19.503,-0.214c4.183,-6.61 3.479,-14.712 2.65,-22.125c-3.315,-29.694 -13.591,-60.841 -41.152,-76.265z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__15_\"></path>\r\n     <path d=\"m336.543,243.976c-18.822,-10.532 -44.414,-5.203 -64.745,2.904c-6.369,2.538 -9.519,5.874 -15.035,9.949c-6.109,4.508 -12.346,9.311 -17.85,14.536c-6.085,5.776 -14.451,9.54 -20.02,4.93c-6.092,-5.049 -0.373,-14.643 -1.057,-20.405c-1.793,-14.93 -19.488,-16.685 -27.456,-4.494c-5.776,8.841 11.177,37.186 22.387,38.754c20.1,2.821 27.117,0.537 38.564,-4.344c18.294,-7.8 56.134,-1.065 77.456,20.772c4.603,4.711 9.858,9.144 14.418,13.884c8.817,9.175 18.263,17.653 30.291,21.918c2.315,0.819 6.481,2.459 8.235,-0.312c3.757,-5.946 3.377,-21.055 2.632,-27.725c-2.983,-26.723 -23.013,-56.485 -47.82,-70.367z\" class=\"side\" id=\"_x33__1_\"></path>\r\n    </g>\r\n    <g id=\"SIDE_1_\">\r\n     <path d=\"m216.665,379.352c-3.504,-6.768 -6.454,-17.439 -7.764,-24.943c-1.456,-8.308 0.508,-17.588 0.548,-26.615c0.024,-5.699 1.171,-11.539 -6.837,-12.099c-8.774,-0.611 -11.176,5.961 -16.145,10.063c-12.89,10.633 -30.256,-2.351 -27.312,-18.262c1.655,-8.915 13.124,-12.598 20.622,-14.624c7.892,-2.133 19.825,-4.825 27.552,-1.02c10.147,4.993 18.809,11.87 22.399,22.475c3.826,11.311 8.639,24.227 17.618,32.004c9.002,7.79 23.159,8.259 34.738,10.269c8.558,1.489 17.249,0.684 25.874,0.416c13.66,-0.427 26.957,2.04 40.358,4.336c8.219,1.41 19.639,2.868 17.359,14.232c-1.54,7.665 -7.321,11.786 -14.196,14.683c-13.241,5.583 -22.19,11.239 -31.636,15.726c-8.014,3.806 -20.001,10.855 -28.12,13.893c-18.094,6.77 -56.123,-3.934 -75.058,-40.534z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__14_\"></path>\r\n     <path d=\"m194.135,293.272c-6.715,0.349 -23.611,4.796 -28.433,8.702c-6.347,5.145 -6.39,11.094 -2.417,18.008c4.159,7.246 12.525,8.506 18.818,5.83c5.209,-2.213 12.325,-12.893 19.803,-12.052c15.649,1.763 8.32,21.227 8.221,31.882c-0.113,12.547 4.879,27.013 10.589,37.755c6.402,12.044 18.51,24.207 31.661,29.412c12.663,5.015 26.716,5.801 39.442,3.057c7.787,-1.678 14.571,-4.955 21.217,-8.945c10.084,-6.048 22.154,-8.795 32.446,-14.438c5.738,-3.153 14.421,-8.005 17.223,-14.233c1.215,-2.695 0.507,-6.814 -1.505,-9.056c-8.138,-9.058 -21.6,-8.032 -32.629,-8.728c-8.502,-0.54 -17.047,-2.068 -25.58,-1.161c-5.444,0.578 -11.113,0.384 -16.624,0.358c-9.71,-0.041 -30.162,-0.496 -47.535,-19.466c-10.703,-11.694 -6.311,-25.226 -21.82,-38.055c-8.304,-6.875 -16.352,-9.209 -22.877,-8.87z\" class=\"side\" id=\"_x33_\"></path>\r\n    </g>\r\n   </g>\r\n   <g id=\"svg_54\">\r\n    <g id=\"svg_55\">\r\n     <path id=\"svg_56\" d=\"m295.434,400.2c-8.091,-5.866 -18.826,-8.023 -28.359,-9.237c-3.616,-0.457 -10.946,-0.71 -14.598,-0.35c-4.799,0.472 -18.152,0.737 -24.498,-1.087c-2.532,-0.728 -7.883,-4.154 -7.883,-4.154c0.176,6.774 8.227,17.572 9.856,19.141c2.768,2.681 10.607,8.032 16.507,10.806c11.435,5.385 32.853,7.36 42.296,5.529c5.442,-1.06 14.029,-5.649 20.954,-10.808c-3.307,-4.444 -11.401,-7.762 -14.275,-9.84z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_57\" d=\"m294.306,400.524c-7.285,-5.278 -17.953,-7.535 -26.536,-8.623c-3.255,-0.413 -10.263,-0.52 -13.548,-0.199c-4.322,0.424 -18.129,1.016 -23.788,0.986c-3.272,-0.02 -7.973,-4.038 -7.973,-4.038c3.226,6.794 8.205,12.9 9.437,14.091c2.491,2.411 11.782,8.019 17.093,10.518c10.291,4.846 30.94,7.199 39.437,5.549c4.899,-0.952 11.766,-5.539 18.513,-8.484c-2.981,-4.004 -10.054,-7.931 -12.635,-9.8z\" fill=\"#F8ECCF\"></path>\r\n    </g>\r\n    <g id=\"svg_58\">\r\n     <path id=\"svg_59\" d=\"m338.243,395.847c0,0 -5.431,-5.669 -6.197,-6.354c-3.646,-3.247 -7.534,-6.543 -12.02,-8.339c-4.737,-1.903 -10.082,-4.118 -15.147,-4.721c-7.333,-0.874 -13.846,0.947 -21.042,2.156c-4.094,0.686 -16.187,2.257 -19.036,1.583c-2.257,-0.532 -12.195,-2.224 -12.195,-2.224c1.176,4.255 0.047,6.336 4.007,12.704c3.508,5.636 7.457,11.199 12.954,14.934c3.172,2.158 6.82,4.051 10.444,5.344c5.357,1.91 12.231,5.294 17.951,5.036c6.806,-0.308 13.543,-0.662 20.472,-2.073c4.383,-0.89 10.467,-4.895 15.196,-6.939c2.036,-0.881 7.566,-6.365 9.622,-7.21c2.178,-0.899 -5.009,-3.897 -5.009,-3.897z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_60\" d=\"m262.318,395.547c-1.243,-1.661 -2.512,-3.553 -4.005,-5.953c-2.507,-4.029 -2.771,-6.048 -3.073,-8.392c-0.036,-0.259 -0.069,-0.521 -0.106,-0.79c3.098,0.54 7.786,1.369 9.204,1.704c4.007,0.948 19.673,-1.529 19.83,-1.554c1.494,-0.253 2.965,-0.529 4.415,-0.801c5.421,-1.03 10.543,-1.998 16.058,-1.344c4.565,0.543 9.559,2.55 13.962,4.319l0.683,0.274c4.157,1.666 7.924,4.854 11.426,7.979c0.518,0.46 4.008,4.074 6.089,6.245l0.288,0.299l0.387,0.162c1.053,0.439 2.145,0.97 2.982,1.441c-0.92,0.678 -2.026,1.592 -3.389,2.737c-1.477,1.235 -3.495,2.929 -4.234,3.248c-1.768,0.764 -3.727,1.798 -5.622,2.793c-3.269,1.724 -6.655,3.51 -9.179,4.022c-6.562,1.339 -13.014,1.716 -20.161,2.036c-4.059,0.183 -9.063,-1.78 -13.477,-3.508c-1.289,-0.505 -2.536,-0.994 -3.715,-1.416c-3.395,-1.208 -6.848,-2.975 -9.992,-5.11c-2.902,-1.981 -5.645,-4.725 -8.371,-8.391l0,0z\" fill=\"#F8ECCF\"></path>\r\n    </g>\r\n    <g id=\"svg_61\">\r\n     <path id=\"svg_62\" d=\"m304.431,275.169c0,0 6.818,-3.892 7.754,-4.332c10.625,-5.001 22.848,-6.211 34.214,-3.247c9.795,2.558 19.534,7.545 27.177,14.209c5.197,4.537 8.903,10.228 11.995,16.333c5.693,11.237 8.717,18.374 8.201,35.25c0,0 -14.704,-14.611 -23.211,-19.152c-7.735,-4.14 -23.112,-7.092 -31.504,-9.998c-6.438,-2.228 -10.708,-6.293 -14.98,-11.44c-3.29,-3.965 -6.929,-7.603 -10.879,-10.91c-1.704,-1.421 -3.467,-2.771 -5.246,-4.095c-0.448,-0.339 -3.521,-2.618 -3.521,-2.618z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_63\" d=\"m308.085,275.393c2.228,-1.261 4.514,-2.541 4.95,-2.745c10.307,-4.85 21.978,-5.96 32.862,-3.121c9.713,2.534 19.074,7.429 26.365,13.784c2.117,1.847 4.04,3.946 5.875,6.411c1.96,2.627 3.806,5.674 5.648,9.315c4.913,9.7 7.88,16.258 8.035,29.688c-4.906,-4.634 -14.092,-12.929 -20.317,-16.259c-5.143,-2.752 -13.458,-4.981 -20.797,-6.944c-4.13,-1.107 -8.033,-2.151 -10.996,-3.18c-5.955,-2.06 -9.937,-5.819 -14.095,-10.823c-3.326,-4.016 -7.072,-7.773 -11.136,-11.169c-1.847,-1.543 -3.73,-2.973 -5.328,-4.167c-0.146,-0.111 -0.563,-0.42 -1.066,-0.79z\" fill=\"#F8ECCF\"></path>\r\n    </g>\r\n    <g id=\"svg_64\">\r\n     <path id=\"svg_65\" d=\"m276.481,338.147c1.757,3.797 4.551,7.337 7.565,10.183c5.43,5.146 12.018,8.975 18.053,13.369c9.886,7.199 51.773,20.086 66.679,21.378c0.492,0.047 33.699,-14.1 26.511,-9.962c-1.755,-11.158 -2.831,-21.486 -27.197,-30.453c-14.391,-5.294 -33.162,-9.351 -48.297,-10.57c-11.036,-0.89 -22.44,1.23 -33.414,-1.007c-4.279,-0.873 -8.12,-2.8 -11.435,-5.152c-0.099,1.682 0.47,9.915 1.535,12.214z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_66\" d=\"m281.261,342.216c-1.213,-1.624 -2.206,-3.28 -2.965,-4.911c-0.528,-1.141 -0.98,-4.75 -1.209,-7.643c2.902,1.637 5.883,2.769 8.895,3.382c6.717,1.37 13.584,1.161 20.219,0.964c4.441,-0.136 9.036,-0.275 13.434,0.077c15.052,1.212 33.797,5.318 47.764,10.455c10.168,3.74 16.94,8.016 20.703,13.078c3.337,4.482 4.192,9.323 4.996,14.435c2.256,-1.247 -30.672,8.468 -24.147,9.033c14.393,1.243 -56.07,-14.01 -65.672,-21c-1.893,-1.38 -3.862,-2.715 -5.763,-4.01c-4.16,-2.829 -8.462,-5.754 -12.099,-9.197c-1.546,-1.465 -2.943,-3.032 -4.156,-4.663l0,0z\" fill=\"#F8ECCF\"></path>\r\n    </g>\r\n    <g id=\"svg_67\">\r\n     <path id=\"svg_68\" d=\"m283.751,350.705c18.58,0.935 33.161,1.284 52.513,8.694c5.766,2.205 32.28,14.727 40.245,22.403c-4.161,5.713 -23.565,15.152 -26.99,16.353c-16.508,5.79 -39.315,-0.513 -55.297,-7.972c-8.815,-4.116 -16.38,-11.859 -22.959,-18.958c-6.404,-6.915 -12.214,-12.958 -17.242,-20.471c2.558,-0.958 20.84,-0.496 29.73,-0.049z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_69\" d=\"m286.757,353.393c16.723,0.843 32.937,4.009 47.772,8.86c6.903,2.26 31.011,12.977 38.177,19.882c-8.767,4.971 -23.241,12.84 -30.479,14.044c-15.529,2.582 -31.662,-0.543 -46.049,-7.256c-7.932,-3.7 -14.745,-10.672 -20.661,-17.061c-5.762,-6.223 -10.992,-11.66 -15.515,-18.426c2.303,-0.861 18.753,-0.445 26.755,-0.043z\" fill=\"#F8ECCF\"></path>\r\n    </g>\r\n    <g id=\"svg_70\">\r\n     <path id=\"svg_71\" d=\"m296.049,235.059c5.006,-0.216 12.72,-1.418 17.745,-1.156c8.894,0.456 17.878,2.214 25.965,6.017c14.246,6.693 39.213,24.683 52.628,54.106c2.886,6.336 4.777,13.086 5.027,20.068c0.261,7.304 -1.289,18.14 -3.927,23.404c-1.344,-0.55 -7.837,-24.435 -16.641,-36.79c-7.028,-9.861 -12.98,-15.796 -23.224,-21.24c-11.185,-5.944 -28.388,-7.681 -38.479,-15.376c-7.923,-6.04 -12.914,-14.83 -20.138,-21.396c-1.968,-1.794 -5.946,-2.711 -7.405,-4.656c0.386,-0.056 6.358,-2.888 8.449,-2.981z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_72\" d=\"m291.731,238.503c1.645,-0.669 3.621,-1.412 4.405,-1.442c1.927,-0.084 4.195,-0.308 6.593,-0.541c3.913,-0.379 7.967,-0.777 10.963,-0.619c9.544,0.492 18.029,2.451 25.215,5.831c11.157,5.241 27.589,16.905 40.253,33.916c4.525,6.073 8.363,12.537 11.407,19.21c2.994,6.571 4.621,13.064 4.85,19.306c0.182,5.169 -0.61,12.586 -2.116,18.042c-0.319,-0.853 -0.655,-1.773 -0.986,-2.683c-2.942,-8.08 -7.878,-21.602 -13.845,-29.975c-0.567,-0.797 -1.134,-1.57 -1.691,-2.323c-6.834,-9.183 -13.067,-14.657 -22.223,-19.524c-4.942,-2.625 -11.036,-4.465 -16.932,-6.24c-7.751,-2.345 -15.77,-4.764 -21.274,-8.956c-4.263,-3.25 -7.761,-7.481 -11.148,-11.57c-2.743,-3.315 -5.581,-6.741 -8.853,-9.721c-1.102,-0.997 -2.548,-1.7 -3.946,-2.38c-0.222,-0.107 -0.45,-0.218 -0.672,-0.331z\" fill=\"#F8ECCF\"></path>\r\n    </g>\r\n    <g id=\"svg_73\">\r\n     <path id=\"svg_74\" d=\"m286.247,286.866c5.026,7.517 10.838,13.556 17.242,20.471c6.573,7.103 14.145,14.846 22.954,18.96c15.984,7.456 58.876,25.381 65.129,22.801c6.368,-16.382 -4.378,-36.376 -13.294,-46.832c-13.445,-15.77 -43.719,-14.514 -62.3,-15.449c-8.894,-0.444 -27.172,-0.912 -29.731,0.049z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_75\" d=\"m289.777,288.426c5.4,-0.263 16.994,-0.069 26.101,0.39c2.389,0.123 4.953,0.204 7.666,0.291c17.749,0.581 42.058,1.377 53.213,14.455c0.871,1.024 1.744,2.12 2.596,3.263c8.216,11.035 15.219,27.353 10.708,40.574c-6.866,0.524 -41.297,-12.893 -62.769,-22.916c-8.45,-3.939 -15.959,-11.623 -22.336,-18.507l-1.75,-1.883c-4.598,-4.949 -8.943,-9.629 -12.803,-14.81c0,0.001 -0.421,-0.57 -0.626,-0.857z\" fill=\"#F8ECCF\"></path>\r\n    </g>\r\n    <g id=\"svg_76\">\r\n     <path id=\"svg_77\" d=\"m308.706,307.195c18.581,0.936 32.935,1.903 52.512,8.693c14.822,5.141 33.021,23.816 31.007,43.068c-15.535,-5.241 -57.069,-4.824 -73.054,-12.287c-8.812,-4.112 -15.485,-12.803 -22.956,-18.956c-4.63,-3.818 -11.396,-5.437 -22.083,-9.326c14.876,-7.646 20.584,-11.896 34.574,-11.192z\" stroke-miterlimit=\"10\" stroke=\"rgb(123, 90, 98)\" fill=\"#E9E1EE\"></path>\r\n     <path id=\"svg_78\" d=\"m280.568,317.282c10.958,-5.774 16.464,-8.673 28.037,-8.089c19.794,0.992 33.167,2.071 51.955,8.586c7.76,2.691 16.16,9.172 21.923,16.915c3.771,5.056 8.017,12.757 7.894,21.625c-7.221,-1.913 -17.998,-3.008 -29.331,-4.155c-15.936,-1.617 -32.413,-3.288 -41.026,-7.309c-5.582,-2.605 -10.432,-7.313 -15.124,-11.871c-2.394,-2.319 -4.863,-4.723 -7.409,-6.821c-3.803,-3.128 -8.779,-4.841 -15.67,-7.199c-0.85,-0.296 -1.749,-0.602 -2.688,-0.927c0.493,-0.257 0.971,-0.508 1.439,-0.755z\" fill=\"#F8ECCF\"></path>\r\n    </g>\r\n   </g>\r\n   <g id=\"svg_79\">\r\n    <g id=\"svg_80\">\r\n     <g id=\"B_13_\">\r\n      <path d=\"m443.994,466.188c-1.303,-3.489 -22.308,-24.097 -26.072,-24.93c-18.383,-4.048 -39.744,-7.226 -56.428,1.275c-12.058,6.134 -20.811,17.027 -21.841,28.475c-0.539,6.024 0.448,14.944 4.157,20.489c6.306,9.432 15.446,16.785 28.34,19.822c11.695,2.75 28.884,0.313 38.724,-5.018c13.643,-7.396 16.215,-23.091 10.097,-33.933c-2.269,-4.014 -6.776,-9.926 -14.729,-11.603c-6.258,-1.316 -22.131,0.745 -25.465,5.047c0.141,-1.595 9.504,-7.335 11.578,-8.073c5.189,-1.844 17.579,-0.539 21.706,0.985c9.947,3.661 29.475,14.36 36.267,20.251l-6.334,-12.787z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__13_\"></path>\r\n      <path d=\"m393.774,441.893c8.313,0.63 16.55,2.292 22.79,3.667c0.684,0.148 1.479,0.301 2.335,0.462c1.432,0.267 24.388,17.305 25.699,17.922l-0.044,8.559c-2.644,-0.628 -20.134,-11.971 -26.341,-14.383c-7.425,-2.883 -22.323,-4.47 -26.981,-1.882c-7.067,3.929 -12.109,9.899 -11.204,10.643c0.684,0.556 11.45,-5.527 18.385,-4.271c6.318,1.142 14.982,3.198 19.009,10.565c4.89,8.935 1.611,23.179 -9.918,29.424c-7.062,3.831 -18.746,5.987 -28.416,5.253c-1.994,-0.149 -3.84,-0.419 -5.484,-0.809c-10.275,-2.416 -18.609,-8.306 -24.755,-17.492c-2.962,-4.434 -3.997,-12.437 -3.49,-18.058c0.873,-9.753 8.478,-19.638 19.377,-25.189c7.593,-3.872 17.099,-5.314 29.038,-4.411z\" class=\"B2\" id=\"_x32__13_\"></path>\r\n     </g>\r\n     <g id=\"B_12_\">\r\n      <path d=\"m352.97,536.402c-4.987,-3.364 -19.23,-22.385 -20.826,-30.764c4.891,-4.452 10.559,-11.445 13.848,-17.479c4.001,16.309 22.649,23.118 28.024,23.435c-1.124,-8.173 -0.638,-12.596 6.081,-19.181c13.325,-13.063 32.685,-2.425 34.674,12.877c3.77,29.03 -40.251,45.64 -61.801,31.112z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__12_\"></path>\r\n      <path d=\"m391.913,534.294c-11.23,4.965 -24.632,9.135 -36.454,3.884c-5.036,-2.245 -21.122,-23.117 -23.312,-32.537c3.964,-3.673 11.813,-12.826 14.386,-17.881c0.862,9.485 17.334,25.662 28.17,25.344c4.294,11.142 12.298,9.715 17.89,5.729c-13.88,2.928 -21.21,-9.643 -11.652,-20.581c10.22,-11.853 22.388,-8.013 27.676,0.48c8.465,13.8 -2.762,27.919 -16.704,35.562z\" class=\"B2\" id=\"_x32__12_\"></path>\r\n     </g>\r\n     <g id=\"svg_81\">\r\n      <path id=\"svg_82\" d=\"m487.567,593.587l0.291,-1.328c6.347,-16.842 -14.893,-76.129 -25.396,-93.256c-9.331,-15.222 -27.31,-33.646 -42.753,-43.809c-24.02,-15.808 -56.145,-24.161 -69.913,-5.149c-2.873,3.968 -4.906,9.056 -6.039,15.128c-2.226,11.914 0.504,16.055 4.639,22.321c1.012,1.534 2.084,3.161 3.157,5.002c1.949,3.343 6.643,9.416 8.121,10.983l1.704,1.805l-46.839,45.043l-1.737,-1.801c-2.572,-2.666 -6.105,-6.941 -9.452,-11.438c-2.205,-2.964 -5.376,-7.425 -7.957,-11.852c-13.028,-22.343 -24.634,-66.323 -3.212,-95.903c0.628,-0.867 1.288,-1.725 1.973,-2.565c42.678,-52.448 97.953,-55.864 155.642,-9.615c3.454,2.77 7.338,5.676 11.449,8.756c15.735,11.778 35.32,26.438 47.331,46.048c8.238,13.431 19.336,39.052 26.34,56.912c17.372,44.278 13.915,65.84 13.915,65.84l-61.264,-1.122z\" fill=\"#7B5A62\"></path>\r\n      <path id=\"svg_83\" d=\"m532.583,529.781c-6.973,-17.785 -18.009,-43.254 -26.142,-56.518c-14.834,-24.211 -41.368,-40.654 -58.213,-54.157c-53.76,-43.1 -108.191,-44.762 -152.133,9.24c-23.205,28.52 -11.838,72.818 1.461,95.627c2.141,3.674 4.95,7.785 7.803,11.618c3.355,4.507 6.772,8.63 9.245,11.195l43.248,-41.589c-1.592,-1.688 -6.404,-7.911 -8.463,-11.441c-5.552,-9.523 -11.068,-13.131 -8.095,-29.046c7.519,-40.257 50.639,-30.794 79.791,-11.61c14.623,9.623 33.45,28.177 43.511,44.592c10.135,16.529 32.511,77.122 25.604,95.449l59.865,-0.825c-0.067,-4.608 -0.261,-18.643 -17.482,-62.535z\" fill=\"#E9E1EE\"></path>\r\n      <path id=\"svg_84\" d=\"m492.065,591.704l55.14,-0.764c-0.279,-6.145 -2.196,-21.379 -17.283,-59.834c-6.945,-17.707 -17.917,-43.047 -25.984,-56.201c-2.47,-4.029 -5.335,-8.237 -8.509,-12.503c-14.769,-19.846 -40.932,-34.643 -54.285,-45.352c-52.769,-42.309 -101.152,-39.87 -144.296,13.158c-22.566,27.733 -11.387,71.022 1.639,93.359c1.96,3.365 4.614,7.315 7.676,11.426c2.67,3.585 5.447,7.016 7.715,9.537l40.42,-38.859c-0.932,-1.131 -2.097,-2.618 -3.233,-4.151c-1.052,-1.408 -2.995,-4.087 -4.199,-6.161c-5.578,-9.569 -7.503,-22.457 -6.368,-30.054c1.199,-8.028 24.495,-49.371 80.891,-13.28c12.962,8.297 28.371,23.382 38.608,37.127c2.058,2.771 3.912,5.49 5.503,8.089c8.944,14.595 31.309,72.074 26.565,94.463z\" fill=\"#D9E0D1\"></path>\r\n      <path id=\"svg_85\" d=\"m537.095,581.306c-2.367,-11.284 -7.413,-26.794 -15.087,-46.346c-7.33,-18.692 -17.969,-42.833 -25.197,-54.627c-2.311,-3.772 -5.005,-7.725 -8.003,-11.758c-14.21,-19.084 -33.02,-36.904 -45.887,-47.225c-48.557,-38.926 -97.179,-33.468 -136.915,15.372c-19.226,23.626 -8.661,62.843 2.516,82.011c1.75,3.004 4.256,6.733 7.062,10.498c0.194,0.258 0.384,0.52 0.582,0.781l26.197,-25.191c-0.97,-1.388 -1.957,-2.87 -2.739,-4.215c-6.721,-11.535 -9.32,-30.081 -6.703,-39.833c7.083,-26.395 58.115,-41.401 95.358,-16.894c13.954,9.178 30.099,24.69 41.13,39.507c2.242,3.009 4.267,5.983 6.018,8.837c6.519,10.64 27.197,58.697 28.541,89.542l33.127,-0.459z\" fill=\"#9CB098\"></path>\r\n      <path id=\"svg_86\" d=\"m522.063,592.706c-0.266,-19.707 -27.888,-85.89 -39.491,-104.813c-12.128,-19.781 -33.979,-41.808 -50.263,-54.86c-41.733,-33.462 -80.256,-29.093 -114.491,12.986c-13.233,16.264 -5.479,47.723 3.931,63.857c1.61,2.764 3.819,5.969 6.029,8.938c2.695,3.618 5.392,6.882 6.997,8.552l2.877,-2.772c-2.723,-2.829 -9.078,-10.95 -12.45,-16.735c-8.845,-15.175 -16.323,-44.514 -4.287,-59.316c17.954,-22.061 37.154,-33.415 57.071,-33.747c16.375,-0.269 33.81,6.915 51.822,21.357c16.009,12.838 37.473,34.457 49.358,53.833c11.125,18.149 38.642,84.026 38.9,102.776l3.997,-0.056z\" fill=\"#8A7C74\"></path>\r\n     </g>\r\n     <g id=\"B_11_\">\r\n      <path d=\"m355.032,562.353c-2.236,-2.108 -4.308,-4.376 -6.214,-6.774c4.432,-3.818 7.127,-9.85 10.342,-15.223c7.004,4.348 15.271,4.983 18.072,2.108c-0.352,-7.612 0.381,-11.652 6.51,-17.33c12.154,-11.262 27.672,-0.305 28.23,13.927c1.065,27.004 -38.929,40.288 -56.94,23.292z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__11_\"></path>\r\n      <path d=\"m390.636,564.464c-9.801,3.918 -21.386,6.971 -30.941,1.426c-4.078,-2.367 -7.715,-5.593 -10.884,-9.416c3.601,-3.154 6.055,-7.761 8.586,-12.273c5.974,5.245 13.801,8.581 21.659,3.627c2.551,6.302 8.284,5.758 13.283,2.417c-11.897,1.875 -17.149,-10.154 -8.312,-19.672c9.463,-10.339 19.415,-6.076 23.252,2.078c6.115,13.23 -4.351,25.588 -16.643,31.813z\" class=\"B2\" id=\"_x32__11_\"></path>\r\n     </g>\r\n     <g id=\"B_10_\">\r\n      <path d=\"m378.644,569.638c-4.466,4.315 -8.882,7.87 -15.494,9.061c-4.505,0.808 -16.219,-1.723 -21.677,-5.153c-3.705,-2.315 -6.667,-8.099 -8.572,-12.066c-0.762,-1.591 -3.32,-6.058 -3.615,-7.71l15.985,-12.057l2.748,1.084c-0.545,3.229 2.627,8.691 5.301,10.878c0.232,0.189 0.504,0.356 0.797,0.517c-1.244,0.959 -2.622,1.752 -4.179,2.31c1.557,-0.557 2.933,-1.349 4.179,-2.31c2.57,1.414 7.258,1.738 9.724,0.842c-2.466,0.896 -7.154,0.572 -9.724,-0.842c5.474,-4.223 8.324,-11.786 12.335,-17.875c-4.011,6.089 -6.865,13.649 -12.335,17.875c-0.294,-0.161 -0.566,-0.328 -0.797,-0.517c-2.674,-2.187 -2.861,-6.466 -2.307,-9.7c0.676,-4.028 3.53,-6.926 6.852,-9.044c5.251,-3.348 12.65,-5.642 18.286,-1.657c2.421,1.711 5.05,4.711 6.677,7.227c1.867,2.892 2.425,8.569 2.518,12.16c0.141,5.501 -4.009,14.376 -6.702,16.977z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__10_\"></path>\r\n      <path d=\"m376.445,567.321c-4.604,4.457 -8.348,7.224 -13.85,8.216c-0.431,0.078 -1.719,0.223 -4.372,-0.092c-5.419,-0.648 -11.897,-2.636 -15.067,-4.624c-3.204,-2.006 -6.242,-8.352 -7.39,-10.745c-0.212,-0.449 -0.56,-1.112 -0.963,-1.881c-0.406,-0.765 -1.14,-2.154 -1.688,-3.306l14.861,-11.714c0.617,4.303 2.545,8.212 5.345,10.5c0.224,0.183 0.491,0.356 0.783,0.528c-1.24,0.953 -2.613,1.74 -4.167,2.301c1.553,-0.56 2.925,-1.345 4.167,-2.301c1.024,0.596 2.385,1.069 3.681,1.222c3.734,0.448 6.056,-0.389 6.056,-0.389c-3.662,-0.556 -6.067,-1.73 -7.501,-2.877c4.098,-4.358 6.681,-10.635 10.116,-15.837c-3.435,5.201 -6.019,11.48 -10.116,15.837c-0.417,-0.333 -0.759,-0.67 -1.017,-0.981c-1.216,-1.506 -1.568,-4.357 -1.181,-6.668c0.442,-2.579 2.217,-4.821 5.42,-6.868c3.778,-2.407 7.751,-3.573 10.904,-3.198c1.452,0.172 2.713,0.648 3.848,1.458c1.891,1.333 4.294,3.946 5.847,6.354c1.099,1.702 1.884,5.822 2.004,10.493c0.121,4.463 -3.532,12.46 -5.72,14.572z\" class=\"B2\" id=\"_x32__10_\"></path>\r\n     </g>\r\n     <g id=\"B_9_\">\r\n      <path d=\"m355.071,568.029c-4.466,4.315 -8.882,7.87 -15.494,9.061c-4.505,0.808 -16.219,-1.723 -21.677,-5.153c-3.705,-2.315 -6.667,-8.099 -8.572,-12.066c-0.762,-1.591 -3.32,-6.058 -3.615,-7.71l15.985,-12.057l2.748,1.084c-0.545,3.229 2.627,8.691 5.301,10.878c0.232,0.189 0.504,0.356 0.797,0.517c-1.244,0.959 -2.622,1.752 -4.179,2.31c1.557,-0.557 2.933,-1.349 4.179,-2.31c2.57,1.414 7.258,1.738 9.724,0.842c-2.466,0.896 -7.154,0.572 -9.724,-0.842c5.474,-4.223 8.324,-11.786 12.335,-17.875c-4.011,6.089 -6.865,13.649 -12.335,17.875c-0.294,-0.161 -0.566,-0.328 -0.797,-0.517c-2.674,-2.187 -2.861,-6.466 -2.307,-9.7c0.676,-4.028 3.53,-6.926 6.852,-9.044c5.251,-3.348 12.651,-5.643 18.287,-1.658c2.421,1.711 5.049,4.713 6.677,7.227c1.867,2.893 2.424,8.57 2.517,12.161c0.141,5.501 -4.009,14.376 -6.702,16.977z\" class=\"B5 B6\" id=\"_x35__9_\"></path>\r\n      <path d=\"m352.872,565.711c-4.605,4.457 -8.348,7.224 -13.85,8.216c-0.431,0.078 -1.719,0.223 -4.372,-0.092c-5.419,-0.648 -11.897,-2.636 -15.067,-4.624c-3.204,-2.006 -6.242,-8.353 -7.39,-10.745c-0.212,-0.449 -0.56,-1.112 -0.963,-1.881c-0.406,-0.765 -1.14,-2.154 -1.688,-3.306l14.861,-11.714c0.617,4.303 2.545,8.212 5.345,10.5c0.224,0.183 0.491,0.356 0.783,0.528c-1.24,0.953 -2.613,1.74 -4.167,2.301c1.553,-0.56 2.925,-1.345 4.167,-2.301c1.024,0.596 2.385,1.069 3.681,1.222c3.734,0.448 6.056,-0.389 6.056,-0.389c-3.662,-0.556 -6.067,-1.73 -7.501,-2.877c4.098,-4.358 6.681,-10.635 10.116,-15.837c-3.435,5.201 -6.019,11.48 -10.116,15.837c-0.418,-0.333 -0.759,-0.67 -1.017,-0.981c-1.216,-1.506 -1.568,-4.357 -1.181,-6.668c0.442,-2.579 2.217,-4.821 5.42,-6.868c3.778,-2.407 7.751,-3.573 10.904,-3.198c1.452,0.172 2.713,0.648 3.848,1.458c1.891,1.333 4.294,3.946 5.847,6.354c1.099,1.702 1.884,5.822 2.004,10.493c0.121,4.464 -3.532,12.46 -5.72,14.572z\" class=\"B2\" id=\"_x32__9_\"></path>\r\n     </g>\r\n     <g id=\"B_8_\">\r\n      <path d=\"m298.224,546.973c-22.558,-19.35 -32.677,-50.199 -22.749,-76.907c3.736,3.877 18.009,11.87 18.009,11.87s-5.278,12.605 -4.136,21.233c2.674,20.318 30.248,27.262 36.347,21.575c-0.545,-8.63 0.31,-13.205 7.895,-19.55c15.038,-12.592 34.576,0.044 35.48,16.184c1.709,30.623 -48.087,45.108 -70.846,25.595z\" class=\"B5 B6\" id=\"_x35__8_\"></path>\r\n      <path d=\"m342.896,548.745c-12.203,4.299 -26.636,7.599 -38.656,1.178c-26.238,-14.009 -38.694,-53.15 -28.766,-79.857c3.736,3.877 18.007,11.872 18.007,11.872s-5.14,13.699 -4.263,22.3c-0.048,3.716 0.774,5.32 1.174,9.396c6.289,9.547 22.143,24.926 37.789,16.09c3.284,7.183 10.437,6.646 16.634,2.926c-10.682,-1.27 -21.915,-8.061 -11.003,-18.725c8.275,-8.808 22.778,-9.252 27.685,0.043c7.831,15.083 -3.331,27.894 -18.601,34.777z\" class=\"B2\" id=\"_x32__8_\"></path>\r\n      <path d=\"m288.569,515.502c-1.33,-3.935 -0.928,-8.548 0.592,-11.772c-0.019,6.769 12.435,26.001 33.973,22.38c0.979,-0.167 2.529,-1.224 3.163,-0.515c0.638,0.712 2.189,5.067 0.738,5.762c-16.779,8.016 -33.867,-2.248 -38.466,-15.855z\" class=\"B1\" id=\"_x31__2_\"></path>\r\n     </g>\r\n     <g id=\"B_7_\">\r\n      <path d=\"m307.929,483.847c0.355,-0.374 0.789,-0.709 1.168,-1.066c-2.806,2.728 -4.447,6.449 -9.081,5.497c-4.46,-0.926 -7.647,-3.623 -7.054,-8.569c0.333,-2.766 1.638,-5.143 3.501,-6.965c4.215,-4.135 11.261,-5.425 16.216,-1.985c10.924,7.576 12.135,24.735 0.292,32.089c-5.204,3.225 -13.145,2.539 -18.882,1.504c-6.093,-1.103 -12.428,-3.547 -17.465,-7.125c-9.535,-6.757 -13.804,-20.699 -13.107,-32.279c1.063,-17.681 9.713,-37.002 22.896,-48.968c7.889,-7.161 18.059,-10.93 27.174,-16.239c10.855,-6.32 37.662,-14.535 55.038,-12.458c10.151,1.216 20.376,2.279 30.312,4.806c6.105,1.552 26.366,9.195 28.63,9.88c-5.55,-0.226 -43.665,-1.929 -50.934,0.076c-18.901,5.208 -40.842,18.571 -52.641,34.176c-4.12,5.448 -13.229,16.871 -13.722,33.247c0.03,0.013 0.066,0.026 0.096,0.042\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__7_\"></path>\r\n      <path d=\"m265.854,450.913c-2.894,24.204 3.884,37.191 13.837,44.498c6.482,4.76 12.73,6.224 18.64,6.928c5.146,0.616 10.806,-0.368 13.325,-1.928c5.49,-3.411 7.233,-8.913 7.21,-13.284c-0.044,-8.179 -2.377,-11.696 -9.491,-14.308c-4.899,-1.796 -14.982,5.258 -13.259,8.593c2.049,3.975 5.301,4.597 11.68,1.335c-0.253,2.71 -2.093,5.659 -7.781,5.532c-5.169,-0.126 -7.647,-3.623 -7.054,-8.569c0.331,-2.768 3.117,-6.685 3.117,-6.685c-8.716,-6.813 -7.982,-22.275 -4.65,-30.763c4.186,-10.651 11.557,-20.854 19.298,-29.583c4.215,-4.753 22.936,-19.854 27.15,-22.112c-13.589,3.969 -43.576,18.256 -51.463,25.414c-9.739,8.84 -17.004,21.691 -20.559,34.932\" class=\"B2\" id=\"_x32__7_\"></path>\r\n      <path d=\"m372.138,398.723c-46.636,10.927 -67.539,56.696 -66.861,67.977l-10.144,6.168c-8.764,-6.776 -7.036,-22.122 -3.705,-30.608c4.188,-10.653 11.56,-20.854 19.298,-29.583c4.215,-4.753 22.69,-20.398 27.152,-22.11c7.272,-2.794 21.653,-4.371 30.747,-3.285c10.156,1.214 20.376,2.279 30.316,4.809c2.969,0.755 15.252,5.084 15.252,5.084l0,0c-11.882,-0.873 -32.719,-0.639 -42.055,1.548z\" class=\"B4\" id=\"_x34_\"></path>\r\n     </g>\r\n    </g>\r\n    <g id=\"B_6_\">\r\n     <path d=\"m399.326,417.555c30.926,-13.423 34.334,-52.732 23.422,-72.533c-18.326,-1.832 -31.996,-2.509 -49.964,16.677c-6.485,6.912 -12.885,43.267 -5.119,60.161c10.863,3.047 25.814,-1.769 31.661,-4.305z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__6_\"></path>\r\n     <path d=\"m370.629,405.098c-1.156,-17.419 4.023,-35.905 6.408,-38.714c14.506,-15.478 25.095,-16.193 41.349,-14.713c11.232,41.202 -28.84,64.11 -45.922,63.963c-0.913,-2.884 -1.564,-6.46 -1.835,-10.53c-0.001,-0.003 -0.001,-0.003 0,-0.006z\" class=\"B2\" id=\"_x32__6_\"></path>\r\n     <path d=\"m405.559,362.035c-5.106,-2.949 -13.686,4.137 -16.681,7.126c-2.108,2.097 -8.909,12.078 -3.191,18.46c8.251,9.194 18.955,-7.43 19.891,-10.407c1.539,-4.894 4.288,-12.694 -0.019,-15.179z\" class=\"B1\" id=\"_x31__1_\"></path>\r\n    </g>\r\n    <g id=\"svg_87\">\r\n     <g id=\"B_5_\">\r\n      <path d=\"m484.328,266.86c-5.8,-1.591 -29.512,0.003 -36.906,4.251c-0.193,6.613 -1.684,17.104 -4.116,23.54c14.972,-7.597 32.176,0.471 35.92,4.342c-6.931,4.475 -9.964,7.721 -10.582,17.106c-1.225,18.621 19.461,26.378 32.357,17.912c24.476,-16.061 8.39,-60.277 -16.673,-67.151z\" class=\"B5 B6\" id=\"_x35__5_\"></path>\r\n      <path d=\"m508.104,297.771c-3.547,-11.749 -9.123,-24.641 -20.804,-30.177c-4.988,-2.362 -31.301,-0.955 -39.879,3.518c-0.199,5.4 -1.956,18.297 -4.114,23.541c7.758,-5.525 30.691,-4.554 37.514,3.872c11.252,-4.003 15.378,3.001 16.006,9.84c-6.83,-12.436 -21.136,-9.804 -23.2,4.573c-2.34,15.482 8.506,22.207 18.396,20.684c15.981,-2.579 19.372,-20.296 16.081,-35.851z\" class=\"B2\" id=\"_x32__5_\"></path>\r\n     </g>\r\n     <g id=\"svg_88\">\r\n      <path id=\"svg_89\" d=\"m554.539,533.441c-0.03,-1.36 -0.074,-2.717 -0.122,-4.068c-2.241,-61.891 -30.315,-114.957 -66.291,-163.14c-14.021,-18.778 -49.934,-49.768 -41.356,-72.759c4.975,-13.32 18.79,-19.804 33.069,-18.421c9.194,0.89 29.432,12.859 34.205,20.464l10.934,-23.114l-77.515,-62.79c0,0 -28.044,22.579 -35.753,31.389c-16.239,18.559 -33.348,46.738 -34.451,72.943c-1.161,27.407 19.855,58.456 34.966,80.953c18.068,26.909 44.753,41.91 59.793,70.182c14.462,27.185 17.53,42.489 20.504,73.252c0.686,7.101 -4.887,55.004 -4.954,55.254c12.131,0.321 54.055,1.177 62.682,0.989c1.521,-20.199 3.774,-41.766 4.289,-61.134\" fill=\"#7B5A62\"></path>\r\n      <path id=\"svg_90\" d=\"m547.747,594.537c2.609,-20.5 4.446,-43.428 4.747,-66.128c-1.907,-52.711 -22.695,-103.979 -65.413,-161.35l-0.488,-0.661c-3.158,-4.238 -7.536,-9.202 -12.169,-14.454c-5.486,-6.219 -11.701,-13.275 -16.988,-20.377c-7.813,-10.496 -17.601,-26.04 -12.453,-39.833c4.978,-13.342 19.097,-21.267 35.133,-19.716c8.436,0.819 25.397,11.15 33.081,18.521l9.388,-18.61l-75.043,-60.783c-5.525,4.485 -27.663,22.607 -34.246,30.13c-7.626,8.713 -32.602,39.632 -33.958,71.711c-1.122,26.523 19.322,56.965 34.252,79.192l0.377,0.563c1.043,1.546 2.148,3.114 3.295,4.657c7.361,9.885 15.994,18.347 24.351,26.531c8.218,8.059 16.717,16.389 23.843,25.964c3.266,4.389 6.017,8.705 8.408,13.202c15.02,28.232 17.852,44.229 20.724,73.998c0.693,7.133 -3.875,56.458 -3.893,56.542c11.353,0.179 49.175,0.81 57.052,0.901z\" fill=\"#CED5D0\"></path>\r\n      <path id=\"svg_91\" d=\"m534.485,594.352c1.631,-19.707 2.74,-41.939 1.927,-64.419c1.945,14.729 -9.15,-91.957 -59.009,-142.722c-7.837,-7.735 -23.787,-20.179 -34.396,-43.469c-6.392,-14.033 -14.986,-40.997 -1.982,-55.66c8.635,-9.739 26.053,-20.717 45.825,-14.564c6.03,1.873 17.989,9.687 26.151,12.753l4.239,-12.126l-73.608,-60.62c-9.369,7.746 -29.327,24.797 -33.677,29.769c-12.72,14.537 -31.056,40.812 -32.211,68.023c-0.908,21.52 23.521,47.401 42.774,68.024c9.104,9.746 23.572,22.035 33.433,33.555c7.729,9.034 20.481,22.158 26.162,32.511c13.412,24.431 21.405,61.573 24.345,92.025c2.81,24.551 -0.494,44.659 -1.309,57.335c8.009,0.195 26.706,-0.277 31.336,-0.415z\" fill=\"#9FB9A8\"></path>\r\n      <path id=\"svg_92\" d=\"m522.827,594.144c1.426,-26.288 -0.368,-50.1 -3.186,-74.397c-6.058,-52.25 -25.579,-93.016 -68.491,-135.199c-7.313,-7.199 -12.862,-15.783 -18.047,-24.611c-12.912,-21.944 -23.006,-48.792 -10.813,-72.697c7.167,-14.058 14.703,-20.523 29.994,-24.096c17.565,-4.106 30.04,-3.751 35.121,0.992l2.734,-2.924c-7.807,-7.284 -25.39,-5.088 -38.769,-1.96c-16.725,3.905 -26.484,11.877 -34.065,26.74c-12.316,24.154 -3.639,54.561 12.577,76.342c0.799,1.074 12.211,17.474 19.533,24.703c39.425,38.909 57.518,82.204 63.689,135.4c2.816,24.284 2.858,45.151 1.885,71.582c0.552,-0.03 7.021,0.153 7.838,0.125z\" fill=\"#7C8168\"></path>\r\n     </g>\r\n     <g id=\"B_4_\">\r\n      <path d=\"m517.246,248.735c-2.934,-0.886 -5.938,-1.558 -8.968,-2.019c-1.101,5.749 -4.987,11.089 -8.047,16.55c7.249,3.909 11.927,10.769 10.817,14.628c-6.768,3.482 -9.917,6.13 -11.788,14.276c-3.715,16.147 13.514,24.149 26.137,17.551c23.95,-12.523 15.561,-53.822 -8.151,-60.986z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__4_\"></path>\r\n      <path d=\"m536.808,278.568c-1.483,-10.454 -4.601,-22.019 -14.169,-27.547c-4.084,-2.359 -8.693,-3.909 -13.584,-4.752c-0.941,4.694 -3.719,9.114 -6.375,13.557c7.526,2.576 14.322,7.696 13.936,16.977c6.732,-0.923 9.115,4.318 8.702,10.318c-4.287,-11.252 -17.338,-9.82 -21.199,2.586c-4.257,13.351 4.4,19.862 13.38,19.129c14.513,-1.277 20.024,-16.511 19.309,-30.268z\" class=\"B2\" id=\"_x32__4_\"></path>\r\n     </g>\r\n     <g id=\"B_3_\">\r\n      <path d=\"m534.048,259.393c1.521,-6.02 2.404,-11.619 0.145,-17.948c-1.537,-4.308 -9.566,-13.203 -15.257,-16.237c-3.856,-2.056 -10.347,-1.75 -14.735,-1.424c-1.757,0.129 -6.904,0.134 -8.484,0.699l-2.496,19.869l2.308,1.846c2.528,-2.089 8.842,-2.052 12.066,-0.823c0.284,0.109 0.564,0.264 0.851,0.435c0.214,-1.554 0.216,-3.142 -0.08,-4.769c0.295,1.627 0.294,3.214 0.08,4.769c2.5,1.527 5.118,5.434 5.57,8.013c-0.451,-2.58 -3.069,-6.487 -5.57,-8.013c-0.942,6.855 -6.082,13.086 -9.364,19.594c3.282,-6.508 8.422,-12.739 9.364,-19.594c-0.287,-0.171 -0.567,-0.326 -0.851,-0.435c-3.223,-1.229 -7.031,0.743 -9.555,2.828c-3.154,2.596 -4.251,6.512 -4.434,10.451c-0.291,6.215 1.402,13.777 7.664,16.681c2.686,1.245 6.6,2.037 9.592,2.193c3.434,0.179 8.639,-2.163 11.799,-3.867c4.844,-2.621 10.473,-10.636 11.387,-14.268z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__3_\"></path>\r\n      <path d=\"m530.947,258.639c1.567,-6.209 2.109,-10.836 0.227,-16.101c-0.143,-0.411 -0.659,-1.601 -2.252,-3.745c-3.261,-4.379 -8.212,-9.009 -11.513,-10.765c-3.332,-1.779 -10.353,-1.258 -12.994,-1.063c-0.498,0.038 -1.25,0.067 -2.116,0.099c-0.861,0.034 -2.433,0.086 -3.706,0.185l-2.76,18.723c4.041,-1.61 8.389,-1.885 11.766,-0.593c0.269,0.104 0.558,0.247 0.847,0.414c0.218,-1.552 0.214,-3.131 -0.078,-4.755c0.291,1.624 0.295,3.203 0.078,4.755c1.027,0.592 2.117,1.539 2.898,2.588c2.24,3.011 2.671,5.444 2.671,5.444c-2.303,-2.9 -4.519,-4.402 -6.227,-5.071c-1.737,5.718 -5.898,11.088 -8.7,16.651c2.802,-5.563 6.963,-10.933 8.7,-16.651c-0.497,-0.197 -0.957,-0.33 -1.352,-0.393c-1.913,-0.31 -4.565,0.807 -6.371,2.301c-2.015,1.657 -3.084,4.308 -3.264,8.109c-0.205,4.478 0.758,8.503 2.658,11.05c0.871,1.174 1.912,2.031 3.179,2.616c2.099,0.971 5.56,1.755 8.424,1.903c2.02,0.104 5.981,-1.261 10.095,-3.482c3.929,-2.125 9.045,-9.273 9.79,-12.219z\" class=\"B2\" id=\"_x32__3_\"></path>\r\n     </g>\r\n     <g id=\"B_2_\">\r\n      <path d=\"m513.281,249.923c1.523,-6.024 2.404,-11.619 0.148,-17.952c-1.544,-4.307 -9.566,-13.203 -15.264,-16.236c-3.852,-2.053 -10.34,-1.751 -14.73,-1.427c-1.753,0.132 -6.907,0.138 -8.487,0.703l-2.496,19.869l2.31,1.848c2.532,-2.086 8.84,-2.053 12.066,-0.823c0.28,0.106 0.567,0.26 0.851,0.435c0.215,-1.56 0.214,-3.148 -0.077,-4.773c0.291,1.624 0.292,3.213 0.077,4.773c2.503,1.523 5.121,5.43 5.568,8.012c-0.446,-2.582 -3.065,-6.489 -5.568,-8.012c-0.941,6.85 -6.078,13.084 -9.364,19.594c3.286,-6.51 8.423,-12.744 9.364,-19.594c-0.284,-0.175 -0.571,-0.329 -0.851,-0.435c-3.225,-1.23 -7.028,0.739 -9.555,2.828c-3.151,2.592 -4.248,6.508 -4.435,10.444c-0.29,6.222 1.403,13.784 7.661,16.685c2.693,1.244 6.606,2.036 9.598,2.192c3.434,0.179 8.636,-2.159 11.792,-3.866c4.851,-2.623 10.478,-10.634 11.392,-14.265z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35_\"></path>\r\n      <path d=\"m510.18,249.168c1.57,-6.213 2.112,-10.84 0.23,-16.105c-0.146,-0.408 -0.659,-1.601 -2.255,-3.741c-3.261,-4.379 -8.214,-9.011 -11.514,-10.772c-3.335,-1.775 -10.352,-1.251 -12.993,-1.057c-0.498,0.032 -1.247,0.063 -2.118,0.097c-0.861,0.029 -2.431,0.088 -3.701,0.182l-2.762,18.722c4.039,-1.611 8.388,-1.88 11.761,-0.591c0.276,0.103 0.565,0.246 0.854,0.413c0.213,-1.549 0.21,-3.134 -0.08,-4.751c0.294,1.62 0.293,3.202 0.08,4.751c1.027,0.592 2.113,1.536 2.891,2.589c2.247,3.01 2.678,5.442 2.678,5.442c-2.303,-2.9 -4.519,-4.402 -6.231,-5.074c-1.736,5.725 -5.894,11.091 -8.701,16.656c2.807,-5.565 6.965,-10.931 8.701,-16.656c-0.496,-0.19 -0.956,-0.324 -1.355,-0.389c-1.913,-0.31 -4.558,0.806 -6.369,2.297c-2.014,1.664 -3.082,4.315 -3.26,8.112c-0.209,4.475 0.755,8.507 2.655,11.054c0.872,1.169 1.915,2.027 3.182,2.612c2.093,0.972 5.556,1.752 8.417,1.904c2.024,0.107 5.985,-1.259 10.102,-3.483c3.923,-2.12 9.043,-9.266 9.788,-12.212z\" class=\"B2\" id=\"_x32__2_\"></path>\r\n     </g>\r\n     <g id=\"B_1_\">\r\n      <path d=\"m471.14,207.325c-24.61,-7.434 -53.305,-0.365 -70.521,19.431c4.609,0.916 16.801,7.607 16.801,7.607s7.887,-9.774 15.216,-12.988c17.274,-7.573 34.05,9.348 32.01,16.477c-7.095,3.65 -10.389,6.422 -12.353,14.947c-3.894,16.912 14.143,25.281 27.368,18.37c25.081,-13.116 16.303,-56.351 -8.521,-63.844z\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__2_\"></path>\r\n      <path d=\"m490.776,239.175c-1.551,-10.944 -4.815,-23.05 -14.828,-28.839c-21.865,-12.621 -58.108,-3.373 -75.329,16.42c4.609,0.916 16.801,7.607 16.801,7.607s8.809,-10.188 16.017,-13.586c2.942,-1.777 4.551,-1.922 7.963,-3.54c10.163,0.119 28.879,4.504 28.228,20.098c7.054,-0.967 9.543,4.519 9.115,10.799c-5.379,-7.217 -15.359,-12.252 -19.405,0.733c-3.639,10.187 1.928,21.007 11.328,20.241c15.203,-1.349 20.858,-15.53 20.11,-29.933z\" class=\"B2\" id=\"_x32__1_\"></path>\r\n      <path d=\"m442.142,215.02c-3.678,0.876 -7.183,3.326 -9.132,5.955c5.385,-3.191 25.776,-3.101 31.68,14.359c0.266,0.796 0.055,2.426 0.88,2.558c0.825,0.133 4.926,-0.781 4.886,-2.163c-0.458,-16.034 -15.605,-23.729 -28.314,-20.709z\" class=\"B1\" id=\"_x31_\"></path>\r\n     </g>\r\n     <g id=\"B\">\r\n      <path d=\"m424.129,251.809c-0.143,0.494 -0.224,1.039 -0.347,1.543c0.97,-3.791 3.385,-7.067 0.245,-10.609c-3.017,-3.411 -6.943,-4.829 -10.94,-1.853c-2.229,1.665 -3.644,3.981 -4.298,6.502c-1.49,5.71 0.901,12.466 6.351,15.054c12.009,5.701 27.496,-1.789 27.974,-15.726c0.211,-6.117 -4.339,-12.661 -8.09,-17.122c-3.987,-4.736 -9.263,-9.009 -14.873,-11.604c-10.611,-4.9 -24.825,-1.665 -34.523,4.708c-14.798,9.722 -27.252,26.843 -31.069,44.233c-2.287,10.405 -0.491,21.103 -0.56,31.653c-0.08,12.559 6.143,39.902 16.593,53.932c6.111,8.2 12.126,16.536 19.264,23.898c4.384,4.522 21.089,18.292 22.813,19.915c-2.955,-4.701 -24.653,-40.158 -26.529,-47.459c-4.89,-18.985 -2.981,-41.417 4.683,-59.421c2.673,-6.285 8.044,-19.873 22.002,-28.452c0.028,0.02 0.055,0.046 0.082,0.066\" stroke-miterlimit=\"10\" class=\"B5 B6\" id=\"_x35__1_\"></path>\r\n      <path d=\"m374.622,231.708c19.549,-14.556 34.193,-15.136 45.479,-10.146c7.358,3.251 11.731,7.946 15.29,12.722c3.092,4.154 5.059,9.552 4.955,12.515c-0.223,6.458 -4.126,10.71 -7.924,12.864c-7.126,4.032 -11.334,3.763 -17.144,-1.109c-3.993,-3.351 -2.893,-15.612 0.856,-15.778c4.471,-0.199 6.63,2.313 6.969,9.468c2.229,-1.569 3.873,-4.63 0.923,-9.502c-2.678,-4.421 -6.943,-4.829 -10.938,-1.851c-2.233,1.662 -4.249,6.031 -4.249,6.031c-10.244,-4.169 -23.287,4.167 -28.991,11.281c-7.157,8.932 -12.335,20.402 -16.053,31.462c-2.028,6.02 -5.805,29.775 -5.663,34.553c-3.324,-13.762 -5.862,-46.879 -3.575,-57.284c2.817,-12.848 10.352,-25.546 20.059,-35.222\" class=\"B2\" id=\"_x32_\"></path>\r\n      <path d=\"m382.265,349.866c-13.737,-45.878 15.552,-86.798 25.677,-91.823l0.297,-11.87c-10.242,-4.222 -22.686,4.909 -28.389,12.025c-7.16,8.936 -12.338,20.406 -16.058,31.464c-2.026,6.022 -6.397,29.83 -5.661,34.555c1.198,7.699 6.989,20.958 12.458,28.3c6.109,8.199 12.126,16.536 19.264,23.898c2.135,2.198 12,10.701 12,10.701l0.007,-0.001c-6.675,-9.871 -16.849,-28.056 -19.595,-37.249z\" class=\"B4\" id=\"_x34__1_\"></path>\r\n     </g>\r\n    </g>\r\n   </g>\r\n  </g>\r\n  <g style=\"display:none\">\r\n  \r\n  \r\n  <polygon id=\"collider\" points=\"4.953999999999986,195.79899999999998 2.000000000000001,244.844 3.532000000000001,255.318 4.341,260.842 5.804,266.259 7.753,271.228 11.833,281.624 19.347999999999995,298 27.349999999999994,310.242 33.132999999999996,319.093 42.016999999999996,325.569 56.338,372.48500000000007 56.016999999999996,406.00000000000006 81.219,440.90600000000006 94.49499999999999,453.678 98.898,457.241 103.208,460.417 113.333,467.876 124.813,472.738 126.54900000000005,471.09699999999987 136.915,475.517 145.11499999999998,477.39 151.135,477.018 159.19,475.06 162.09199999999998,474.353 178.045,473.28900000000004 183.819,474.03700000000003 208.695,486.10600000000005 213.643,488.46900000000005 220.945,491.963 233.28,491.79400000000004 235.93,493.48400000000004 275.666,527.6229999999999 278.002,535.914 298.22399999999993,546.9730000000001 304.24,549.923 305.71299999999997,552.161 306.008,553.813 308.566,558.28 309.328,559.871 311.233,563.838 314.195,569.622 317.9,571.937 323.358,575.3670000000001 335.072,577.898 358.645,579.5070000000001 363.15,578.6990000000001 373.043,579.3489999999999 374.178,573.9530000000001 378.644,569.638 380.83500000000004,568.3820000000001 381.3369999999999,567.0369999999998 390.636,564.464 413.037,566.0649999999999 413.39400000000006,545.881 418.541,534.32 411.414,524.829 417.082,512.532 462.462,499.00300000000004 472.96500000000003,516.13 492.5220000000001,538.3320000000001 493.2080000000001,545.4330000000001 487.567,593.5870000000002 503.14899999999994,594.767 511.15799999999996,594.9620000000001 541.623,594.7630000000001 548.831,594.7090000000002 550.2500000000001,594.5750000000002 552.288,573.1470000000002 554.0240000000001,552.8090000000002 554.5390000000001,533.4410000000001 554.539,533.441 554.509,532.081 554.465,530.724 554.417,529.373 550.5869999999999,475.698 552.176,467.482 529.7989999999999,424.43 524.102,414.41600000000005 477.403,387.211 487.0809999999999,367.05899999999997 488.12600000000003,366.23300000000006 488.105,342.477 501.001,334.01099999999997 508.004,331.04299999999995 525.477,317.95 525.3969999999999,309.721 532.0120000000001,307.55899999999997 549.347,297.198 540.958,255.899 532.656,237.13699999999997 524.627,228.24199999999996 518.936,225.20799999999997 515.08,223.15199999999996 503.863,218.768 498.16499999999996,215.735 494.313,213.68200000000002 454.083,197.715 446.53,199.891 401.93999999999994,173.99899999999997 396.43499999999995,167.59399999999997 392.68699999999995,163.23199999999997 379.28499999999997,156.35799999999995 377.738,157.86 371.25699999999995,155.31899999999996 365.81899999999996,154.61299999999997 318.26500000000004,136.95799999999997 312.571,130.93499999999997 307.72200000000004,127.34499999999997 299.821,124.45899999999997 288.15500000000003,120.20799999999997 275.877,118.04799999999997 263.32300000000004,118.80099999999997 257.978,119.12199999999997 252.34600000000003,119.71799999999998 247.12500000000003,120.72699999999998 243.80600000000004,121.36999999999998 242.18200000000002,122.26300000000003 240.86200000000008,122.701 240.14700000000008,122.254 238.324,123.70600000000003 235.91200000000003,124.39899999999997 234.26000000000008,123.21399999999998 232.02000000000004,125.31599999999997 229.94499999999994,126.79100000000003 228.20899999999997,127.35099999999996 227.167,127.54800000000003 226.60800000000006,128 225.423,128.209 225.337,128.243 225.33300000000003,128.24399999999997 225.33299999999997,128.24399999999997 225.33100000000005,128.24199999999996 224.5870000000001,128.286 187.531,90.597 187.221,84.321 181.37800000000001,74.54499999999999 177.05100000000002,70.264 162.51999999999998,61.50500000000001 163.89100000000002,57.236999999999995 125.631,32.593999999999994 119.98899999999999,27.583 103.032,12.928999999999998 102.606,5.251999999999999 102.428,1.9999999999999991 83.934,9.341999999999999 66.512,43.653999999999996 52.708,55.992 48.168,60.047999999999995 41.83,69.51299999999999 41.205,75.764 40.372000000000014,84.057 43.483000000000004,94.62700000000001 13.486999999999988,137.80599999999998 8.907999999999987,168.92 4.953999999999986,195.79899999999998\" fill=\"none\" stroke=\"red\" stroke-width=\"3\"></polygon>\r\n\r\n  <line stroke=\"#FF0000\" y2=\"594.499211\" x2=\"550.24927\" y1=\"593.499212\" x1=\"487.499353\" id=\"direct\"></line>\r\n  <circle stroke=\"#000000\"  r=\"278\" cy=\"297.999983\" cx=\"282.730942\" fill=\"red\" id=\"boundingCircle\"></circle>\r\n </g>\r\n</svg>";

},{}],30:[function(require,module,exports){
module.exports = "<svg version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\" y=\"0px\" width=\"1\" height=\"1\" style=\"overflow:visible\">\r\n\t<g id=\"IMAGE\"></g>\r\n\t<g id=\"海石榴華\">\r\n\t\t<g id=\"invisible\" style=\"display:none;\">\r\n\t\t\t<circle class=\"boundingCircle\" style=\"display:inline;fill:#6E86B1;\" cx=\"148.932\" cy=\"148.648\" r=\"148.648\"></circle>\r\n\t\t\t<polygon id=\"collider\" points=\"45.646,69.902 46.12799999999999,70.827 45.513000000000005,74.32799999999999 40.835,83.286 27.809000000000005,101.295 26.099,101.33 22.208,104.184 22.121000000000006,104.194 20.864000000000004,105.269 17.667000000000005,108.00500000000001 16.951,108.041 12.979999999999999,115.023 -0.8990000000000009,128.493 4.673,149.82900000000004 4.108,152.22000000000003 3.976,154.91000000000003 3.3890000000000002,166.87900000000002 1.6750000000000007,179.353 11.463,190.40400000000002 12.841,191.71800000000002 25.998999999999995,199.62900000000002 28.078999999999997,200.276 30.142999999999997,200.705 37.308,202.24099999999999 40.601,202.877 60.05800000000001,200.67200000000005 65.663,205.612 66.97500000000001,207.57500000000005 68.812,208.027 71.474,210.106 74.311,214.89700000000005 85.53900000000002,220.29600000000005 96.08899999999998,224.327 99.22399999999999,225.807 108.39499999999998,228.34099999999998 114.24499999999999,228.78499999999997 122.074,227.82899999999998 131.29799999999997,225.23200000000003 136.664,224.59100000000004 140.74699999999999,219.91900000000004 160.351,224.59100000000004 165.717,225.23200000000003 174.94,227.82899999999998 182.76899999999998,228.78499999999997 188.61899999999997,228.34099999999998 197.79,225.807 200.92499999999998,224.327 211.476,220.29600000000005 222.704,214.89700000000005 225.53999999999996,210.106 228.20199999999997,208.027 230.04000000000002,207.57500000000005 231.351,205.612 236.95700000000002,200.67200000000005 256.41300000000007,202.877 259.706,202.24099999999999 266.8710000000001,200.705 268.9350000000001,200.276 271.0150000000001,199.62900000000002 284.1730000000001,191.71800000000002 285.5510000000001,190.40400000000002 295.33900000000017,179.353 293.6250000000001,166.87900000000002 293.0380000000001,154.91000000000003 292.9060000000001,152.22000000000003 292.3410000000001,149.82900000000004 297.914,128.493 284.03499999999997,115.023 280.06399999999996,108.041 279.34799999999996,108.00500000000001 276.15099999999995,105.269 274.89399999999995,104.194 274.80699999999996,104.184 270.916,101.33 269.20599999999996,101.295 256.18,83.286 251.501,74.32799999999999 250.88600000000002,70.827 251.369,69.902 245.34900000000002,66.972 240.899,60.024 238.60700000000003,58.91 235.274,56.399 234.114,56.36100000000002 232.301,54.483000000000004 228.87300000000002,52.706999999999994 226.52100000000002,52.167000000000016 224.854,50.42 219.399,48.836 214.752,47.487 207.89,46.844 206.707,46.844 204.999,46.844 201.512,47.66900000000001 195.492,48.26499999999999 191.112,46.55900000000001 186.16299999999998,27.241000000000007 184.73899999999998,23.327000000000005 183.886,21.650000000000006 182.198,18.334000000000007 188.70399999999998,-2.0629999999999953 200.99399999999997,-9.962999999999994 203.754,-12.735999999999995 208.44899999999998,-17.455999999999996 207.422,-21.491999999999997 206.74099999999999,-23.246999999999993 205.39299999999997,-26.714999999999993 203.25799999999998,-33.65599999999999 199.004,-38.487 187.696,-47.352 169.676,-40.586 164.60299999999998,-41.334 161.736,-42.42100000000001 155.85999999999999,-44.53600000000001 151.903,-38.40800000000001 150.861,-35.056000000000004 150.036,-32.537000000000006 141.95299999999997,-21.195 129.757,-7.749000000000003 121.579,-4.794000000000003 118.815,-2.110000000000003 116.051,0.573 113.191,6.004 110.825,8.813 106.10300000000001,14.609000000000002 111.453,21.512999999999998 114.825,24.019 117.343,25.953 129.086,27.794999999999998 127.03200000000001,46.169 119.24,51.565000000000005 116.974,50.416000000000004 114.649,49.60600000000001 113.744,49.945 112.151,49.882999999999996 105.903,46.55900000000001 101.522,48.26499999999999 95.503,47.66900000000001 92.01599999999999,46.845 90.30799999999999,46.845 89.125,46.845 82.263,47.488 77.616,48.836999999999996 72.161,50.421 70.493,52.167000000000016 68.141,52.706999999999994 64.714,54.484 62.900000000000006,56.36100000000002 61.741,56.4 58.407000000000004,58.91 56.116,60.025 45.646,69.902\" fill=\"none\" stroke=\"red\" stroke-width=\"3\"></polygon>\r\n\t\t</g>\r\n\t\t\r\n\t\t<g id=\"花柱\">\r\n\t\t\t<g>\r\n\t\t<path class=\"C6 C5\" d=\"M193.624-37.427c0,0,0.964-3.665-1.283-5.751\r\n\t\t\tc-4.645-4.174-10.621,0.01-12.848,2.722c-1.715,2.022-13.555,18.895-2.622,28.257c11.833,10.136,24.123,2.236,26.883-0.537\r\n\t\t\tc4.695-4.72,3.668-8.756,2.987-10.511c-1.348-3.468-4.648-5.306-4.648-5.306s1.165-5.103-0.964-7.519\r\n\t\t\tC199.004-38.487,193.624-37.427,193.624-37.427z\"></path>\r\n\t\t<path style=\"fill:#ACBCBD;\" d=\"M191.748-35.104c0.536-0.569,3.351-1.645,6.663,1.651c2.232,2.221,0.9,5.448,0.9,5.448\r\n\t\t\ts1.737,0.99,2.06,1.286c0.682,0.625,1.111,1.284,1.5,2.088c0.77,1.59,1.269,3.182,0.686,4.932\r\n\t\t\tc-0.854,2.554-0.148,2.026-2.647,4.077c-0.691,0.567-7.556,4.241-9.374,4.614c-1.524,0.313-7.389,0.326-9.824-1.204\r\n\t\t\tc-1.368-0.861-2.745-2.027-3.677-3.418c-0.96-1.432-2.475-6.662-2.481-9.496c-0.004-2.24,0.212-3.585,1.071-5.494\r\n\t\t\tc0.697-1.552,2.241-4.879,3.386-6.172c0.7-0.79,4.208-4.577,5.713-4.976c1.607-0.424,3.421,0.259,4.48,1.548\r\n\t\t\tC190.651-39.674,191.929-37.16,191.748-35.104z\"></path>\r\n\t\t<path style=\"fill:#778581;\" d=\"M189.402-30.131c0.792,0.12,1.554,0.379,2.15,0.729c0.905,0.531,1.855,1.74,2.398,2.625\r\n\t\t\tc0.534,0.87,0.788,1.842,0.805,2.86c0.033,1.915-0.493,3.979-1.373,5.675c-0.979,1.889-2.821,4.599-4.949,5.301\r\n\t\t\tc-2.402,0.792-5.288,0.437-7.117-1.375c-1.209-1.197-2.532-3.451-2.479-5.086c0.083-2.573,1.462-5.104,3.264-7.122\r\n\t\t\tc1.151-1.287,2.913-2.542,4.469-3.295C187.374-30.21,188.409-30.282,189.402-30.131z\"></path>\r\n\t</g>\r\n\t<g>\r\n\t\t<path class=\"C6 C5\" d=\"M165.093-37.578c0,0-0.49-3.756-3.357-4.843\r\n\t\t\tc-5.876-2.115-9.833,4.013-10.875,7.365c-0.825,2.519-5.433,22.61,8.224,27.161c14.779,4.928,23.186-7.022,24.696-10.63\r\n\t\t\tc2.57-6.143,0.099-9.495-1.194-10.861c-2.557-2.705-6.306-3.163-6.306-3.163s-0.846-5.167-3.726-6.601\r\n\t\t\tC169.676-40.586,165.093-37.578,165.093-37.578z\"></path>\r\n\t\t<path style=\"fill:#ACBCBD;\" d=\"M164.229-34.718c0.282-0.73,2.484-2.788,6.793-0.983c2.906,1.217,2.888,4.708,2.888,4.708\r\n\t\t\ts1.982,0.261,2.393,0.415c0.866,0.321,1.514,0.77,2.178,1.369c1.31,1.183,2.373,2.468,2.493,4.308\r\n\t\t\tc0.172,2.687,0.627,1.934-0.915,4.773c-0.428,0.786-5.401,6.777-6.943,7.808c-1.296,0.865-6.722,3.086-9.553,2.587\r\n\t\t\tc-1.593-0.282-3.307-0.843-4.695-1.78c-1.428-0.963-4.802-5.238-5.877-7.859c-0.85-2.073-1.156-3.401-1.079-5.493\r\n\t\t\tc0.061-1.701,0.237-5.365,0.81-6.994c0.349-0.996,2.173-5.825,3.415-6.762c1.329-0.998,3.268-1.047,4.734-0.253\r\n\t\t\tC161.491-38.538,163.622-36.69,164.229-34.718z\"></path>\r\n\t\t<path style=\"fill:#778581;\" d=\"M163.932-29.229c0.776-0.187,1.582-0.234,2.268-0.135c1.038,0.15,2.372,0.912,3.209,1.527\r\n\t\t\tc0.823,0.605,1.426,1.411,1.826,2.347c0.75,1.761,1.042,3.871,0.866,5.773c-0.194,2.119-0.88,5.325-2.588,6.775\r\n\t\t\tc-1.926,1.64-4.733,2.4-7.109,1.411c-1.572-0.653-3.646-2.241-4.213-3.776c-0.894-2.415-0.569-5.279,0.339-7.828\r\n\t\t\tc0.579-1.625,1.738-3.452,2.895-4.736C162.022-28.535,162.954-28.993,163.932-29.229z\"></path>\r\n\t</g>\r\n\t<g>\r\n\t\t<path class=\"C6 C5\" d=\"M152.914-17.513c0,0-1.652-3.409-4.717-3.532\r\n\t\t\tc-6.244-0.15-8.06,6.917-7.988,10.426c0.014,2.65,2,23.166,16.394,23.165c15.581-0.001,19.774-13.997,20.065-17.896\r\n\t\t\tc0.496-6.641-2.908-9.037-4.566-9.926c-3.281-1.758-6.984-1.006-6.984-1.006s-2.436-4.634-5.621-5.084\r\n\t\t\tC156.31-21.816,152.914-17.513,152.914-17.513z\"></path>\r\n\t\t<path style=\"fill:#ACBCBD;\" d=\"M152.999-14.527c0.038-0.782,1.475-3.43,6.136-3.083c3.14,0.234,4.229,3.554,4.229,3.554\r\n\t\t\ts1.96-0.379,2.397-0.365c0.926,0.031,1.68,0.252,2.499,0.611c1.618,0.708,3.033,1.591,3.728,3.3\r\n\t\t\tc1.014,2.493,1.206,1.634,0.644,4.817c-0.158,0.881-2.98,8.136-4.117,9.603c-0.955,1.229-5.401,5.054-8.245,5.476\r\n\t\t\tc-1.6,0.237-3.404,0.247-5.016-0.203c-1.66-0.462-6.214-3.451-8.063-5.597c-1.461-1.698-2.171-2.862-2.761-4.869\r\n\t\t\tc-0.48-1.634-1.472-5.165-1.444-6.891c0.016-1.056,0.217-6.214,1.102-7.495c0.943-1.368,2.766-2.028,4.409-1.74\r\n\t\t\tC149.193-17.285,151.8-16.206,152.999-14.527z\"></path>\r\n\t\t<path style=\"fill:#778581;\" d=\"M154.453-9.226c0.679-0.423,1.426-0.722,2.108-0.844c1.032-0.187,2.54,0.113,3.527,0.433\r\n\t\t\tc0.973,0.313,1.799,0.886,2.473,1.648c1.271,1.432,2.216,3.343,2.65,5.204c0.485,2.071,0.849,5.329-0.309,7.246\r\n\t\t\tc-1.312,2.164-3.734,3.773-6.302,3.586c-1.696-0.123-4.167-0.973-5.19-2.249c-1.612-2.008-2.212-4.827-2.154-7.533\r\n\t\t\tc0.035-1.726,0.558-3.824,1.248-5.41C152.861-7.965,153.602-8.692,154.453-9.226z\"></path>\r\n\t</g>\r\n\t<g>\r\n\t\t<path class=\"C6 C5\" d=\"M169.417,8.852c0,0,0.593-3.743-1.854-5.594\r\n\t\t\tc-5.037-3.688-10.566,1.072-12.511,3.994c-1.504,2.183-11.597,20.155,0.218,28.378c12.787,8.901,24.225-0.19,26.692-3.224\r\n\t\t\tc4.201-5.165,2.777-9.079,1.924-10.756c-1.688-3.316-5.156-4.814-5.156-4.814s0.648-5.196-1.71-7.385\r\n\t\t\tC174.664,7.26,169.417,8.852,169.417,8.852z\"></path>\r\n\t\t<path style=\"fill:#ACBCBD;\" d=\"M167.782,11.352c0.477-0.621,3.169-1.973,6.793,0.975c2.444,1.988,1.44,5.333,1.44,5.333\r\n\t\t\ts1.828,0.81,2.18,1.073c0.739,0.553,1.232,1.166,1.7,1.928c0.925,1.506,1.58,3.04,1.176,4.837\r\n\t\t\tc-0.592,2.625,0.055,2.031-2.227,4.32c-0.631,0.634-7.094,4.977-8.864,5.53c-1.487,0.463-7.32,1.062-9.895-0.216\r\n\t\t\tc-1.448-0.719-2.936-1.743-4.001-3.033c-1.1-1.327-3.13-6.381-3.42-9.2c-0.229-2.227-0.146-3.589,0.518-5.573\r\n\t\t\tc0.536-1.615,1.741-5.079,2.75-6.481c0.618-0.856,3.729-4.975,5.187-5.521c1.557-0.583,3.43-0.083,4.612,1.093\r\n\t\t\tC166.233,6.914,167.756,9.287,167.782,11.352z\"></path>\r\n\t\t<path style=\"fill:#778581;\" d=\"M165.945,16.533c0.798,0.041,1.583,0.223,2.213,0.511c0.953,0.437,2.019,1.545,2.646,2.371\r\n\t\t\tc0.62,0.813,0.97,1.755,1.089,2.766c0.225,1.902-0.094,4.01-0.8,5.784c-0.784,1.978-2.347,4.858-4.394,5.77\r\n\t\t\tc-2.312,1.028-5.219,0.964-7.221-0.656c-1.322-1.07-2.862-3.18-2.975-4.812c-0.177-2.57,0.944-5.225,2.537-7.414\r\n\t\t\tc1.014-1.396,2.643-2.82,4.114-3.726C163.919,16.658,164.94,16.483,165.945,16.533z\"></path>\r\n\t</g>\r\n\t<g>\r\n\t\t<path class=\"C6 C5\" d=\"M117.629,6.944c0,0-4.438-0.94-6.804,1.869\r\n\t\t\tc-4.722,5.796,0.628,12.7,4,15.206c2.518,1.934,23.38,15.115,33.943,1.499c11.436-14.736,1.274-28.976-2.2-32.113\r\n\t\t\tc-5.915-5.345-10.682-3.883-12.741-2.967c-4.07,1.813-6.077,5.866-6.077,5.866s-6.171-1.098-8.935,1.586\r\n\t\t\tC116.051,0.573,117.629,6.944,117.629,6.944z\"></path>\r\n\t\t<path style=\"fill:#ACBCBD;\" d=\"M120.518,9.055c-0.713-0.609-2.163-3.913,1.587-8.064c2.526-2.798,6.464-1.393,6.464-1.393\r\n\t\t\ts1.082-2.135,1.417-2.538c0.707-0.85,1.47-1.402,2.411-1.915c1.858-1.011,3.731-1.7,5.858-1.104\r\n\t\t\tc3.102,0.871,2.43,0.059,5.026,2.928c0.718,0.794,5.51,8.791,6.061,10.942c0.462,1.807,0.817,8.818-0.871,11.818\r\n\t\t\tc-0.951,1.686-2.267,3.401-3.874,4.594c-1.656,1.231-7.822,3.346-11.211,3.519c-2.678,0.135-4.3-0.047-6.631-0.962\r\n\t\t\tc-1.898-0.745-5.966-2.398-7.579-3.693c-0.985-0.79-5.717-4.767-6.28-6.543c-0.6-1.896,0.112-4.105,1.592-5.446\r\n\t\t\tC115.115,10.629,118.047,8.957,120.518,9.055z\"></path>\r\n\t\t<path style=\"fill:#778581;\" d=\"M126.599,11.57c0.098-0.951,0.364-1.879,0.748-2.614c0.582-1.114,1.974-2.318,3-3.018\r\n\t\t\tc1.01-0.691,2.157-1.052,3.375-1.131c2.287-0.15,4.785,0.36,6.865,1.314c2.316,1.062,5.665,3.107,6.626,5.611\r\n\t\t\tc1.085,2.827,0.829,6.3-1.231,8.592c-1.362,1.515-3.979,3.227-5.938,3.259c-3.083,0.05-6.188-1.453-8.708-3.492\r\n\t\t\tc-1.604-1.299-3.207-3.334-4.198-5.15C126.623,14.002,126.477,12.768,126.599,11.57z\"></path>\r\n\t</g>\r\n\t<g>\r\n\t\t<path class=\"C6 C5\" d=\"M152.33,19.424c0,0-0.49-3.756-3.357-4.844\r\n\t\t\tc-5.875-2.115-9.835,4.015-10.876,7.364c-0.826,2.52-5.431,22.61,8.224,27.162c14.781,4.928,23.188-7.022,24.696-10.63\r\n\t\t\tc2.571-6.143,0.101-9.493-1.193-10.862c-2.556-2.705-6.306-3.163-6.306-3.163s-0.846-5.167-3.725-6.601\r\n\t\t\tC156.912,16.416,152.33,19.424,152.33,19.424z\"></path>\r\n\t\t<path style=\"fill:#ACBCBD;\" d=\"M151.466,22.285c0.283-0.73,2.483-2.789,6.795-0.983c2.906,1.216,2.888,4.708,2.888,4.708\r\n\t\t\ts1.982,0.26,2.392,0.413c0.866,0.322,1.514,0.771,2.177,1.371c1.312,1.183,2.372,2.468,2.494,4.309\r\n\t\t\tc0.172,2.687,0.625,1.934-0.915,4.773c-0.428,0.786-5.4,6.777-6.942,7.808c-1.297,0.865-6.725,3.087-9.555,2.588\r\n\t\t\tc-1.591-0.281-3.308-0.843-4.693-1.78c-1.43-0.963-4.802-5.238-5.877-7.86c-0.851-2.073-1.156-3.4-1.081-5.492\r\n\t\t\tc0.063-1.702,0.238-5.365,0.81-6.995c0.351-0.996,2.172-5.825,3.417-6.76c1.327-0.999,3.265-1.05,4.731-0.256\r\n\t\t\tC148.729,18.465,150.86,20.311,151.466,22.285z\"></path>\r\n\t\t<path style=\"fill:#778581;\" d=\"M151.169,27.774c0.777-0.187,1.582-0.234,2.267-0.135c1.037,0.149,2.373,0.913,3.21,1.527\r\n\t\t\tc0.823,0.605,1.427,1.41,1.824,2.345c0.753,1.762,1.043,3.873,0.867,5.775c-0.195,2.119-0.88,5.324-2.585,6.775\r\n\t\t\tc-1.928,1.639-4.735,2.4-7.112,1.41c-1.57-0.652-3.646-2.241-4.213-3.776c-0.893-2.415-0.568-5.279,0.34-7.829\r\n\t\t\tc0.579-1.624,1.739-3.451,2.895-4.735C149.259,28.467,150.191,28.01,151.169,27.774z\"></path>\r\n\t</g>\r\n\t\t\t<path id=\"_x35__13_\" class=\"C6 C5\" d=\"M140.282,49.544c0,0-2.25-3.875-5.875-3.75\r\n\t\t\t\tc-7.375,0.375-8.895,8.869-8.5,13c0.25,3.125,4.4,27.145,21.375,25.875c18.375-1.375,22.086-18.25,22.086-22.875\r\n\t\t\t\tc0-7.875-4.228-10.402-6.263-11.305c-4.023-1.783-8.323-0.57-8.323-0.57s-3.281-5.25-7.078-5.5S140.282,49.544,140.282,49.544z\"></path>\r\n\t\t\t<path id=\"_x34__13_\" style=\"fill:#ACBCBD;\" d=\"M140.644,53.058c-0.024-0.926,1.438-4.175,6.964-4.175\r\n\t\t\t\tc3.723,0,5.299,3.817,5.299,3.817s2.281-0.621,2.799-0.642c1.092-0.044,2.002,0.15,3,0.5c1.972,0.691,3.718,1.61,4.688,3.563\r\n\t\t\t\tc1.416,2.851,1.566,1.822,1.182,5.625c-0.106,1.053-2.796,9.858-4.009,11.688c-1.018,1.535-5.923,6.438-9.239,7.186\r\n\t\t\t\tc-1.865,0.421-3.993,0.591-5.934,0.203c-1.999-0.399-7.631-3.52-10.001-5.89c-1.874-1.874-2.813-3.183-3.686-5.499\r\n\t\t\t\tc-0.71-1.885-2.191-5.961-2.311-8c-0.073-1.246-0.291-7.347,0.639-8.936c0.993-1.696,3.084-2.636,5.047-2.439\r\n\t\t\t\tC135.914,50.141,139.082,51.183,140.644,53.058z\"></path>\r\n\t\t\t<path id=\"_x32__13_\" style=\"fill:#778581;\" d=\"M142.828,59.182c0.761-0.559,1.617-0.978,2.41-1.183\r\n\t\t\t\tc1.201-0.311,3.006-0.088,4.199,0.201c1.175,0.284,2.199,0.886,3.063,1.726c1.625,1.578,2.905,3.748,3.582,5.902\r\n\t\t\t\tc0.755,2.401,1.473,6.21,0.273,8.572c-1.354,2.668-4.069,4.78-7.114,4.787c-2.012,0.004-4.999-0.78-6.32-2.195\r\n\t\t\t\tc-2.078-2.227-3.032-5.499-3.205-8.695c-0.11-2.038,0.32-4.559,0.995-6.489C141.061,60.81,141.87,59.886,142.828,59.182z\"></path>\r\n\t\t</g>\r\n\t\t<g id=\"C4\">\r\n\t\t\t<g id=\"Down\">\r\n\t\t\t\t<g id=\"R_2_\">\r\n\t\t\t\t\t<g>\r\n\t\t\t\t\t\t<path id=\"_x35__12_\" class=\"C4 C6\" d=\"M221.654,172.538\r\n\t\t\t\t\t\t\tc-2.196-16.019-29.779-26.115-47.234-24.857c-16.941,1.22-40.407,10.212-51.691,22.688c0,0,36.295,18.041,39.787,36.298\r\n\t\t\t\t\t\t\tc1.104,5.775,4.91,10.67,7.394,15.995c0.231,0.497,8.436-0.295,13.913-4.958c9.478-8.068,18.435-13.729,25.281-19.278\r\n\t\t\t\t\t\t\tc-4.699-6.438-8.811-13.219-10.397-21.683c1.587,8.464,5.698,15.244,10.397,21.683\r\n\t\t\t\t\t\t\tC217.941,191.26,223.264,184.279,221.654,172.538z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__12_\" class=\"C3\" d=\"M198.707,176.742c1.313,7.004,4.351,12.857,8.023,18.317\r\n\t\t\t\t\t\t\tc0.531-0.552,0.902-0.979,1.025-1.203c2.842-5.201,4.541-11.428,3.811-17.53c-1.184-9.885-13.766-18.253-25.918-19.755\r\n\t\t\t\t\t\t\tc-14.489-1.791-25.354-0.281-41.508,8.37c-4.466,2.393-8.892,4.949-11.567,8.569c6.048,1.022,8.746,0.103,13.998,2.152\r\n\t\t\t\t\t\t\tc5.761,2.249,15.423,9.826,18.469,14.256c5.999,8.72,5.031,15.079,10.299,24.259c2.268,3.955,6.509,0.704,13.958-4.505\r\n\t\t\t\t\t\t\tc6.232-4.356,14.532-11.597,17.435-14.613C203.058,189.599,200.02,183.746,198.707,176.742z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__12_\" class=\"C2\" d=\"M198.707,176.742c0.519,2.768,1.321,5.346,2.312,7.8\r\n\t\t\t\t\t\t\tc0.938-5.484-0.055-11.05-4.244-15.939c-5.279-6.16-13.451-9.092-21.193-9.185c-7.829-0.095-15.044,1.741-22.102,4.869\r\n\t\t\t\t\t\t\tc-3.883,1.722-8.239,4.671-12.389,5.615c0,0,4.672-1.067,10.483,0.703c5.543,1.691,11.939,7.304,15.183,10.947\r\n\t\t\t\t\t\t\tc7.674,8.637,6.698,21.182,11.695,31.144c0.811,0.291,5.524-4.202,6.263-4.772c2.809-2.162,5.502-4.441,7.877-7.021\r\n\t\t\t\t\t\t\tc1.956-2.122,3.697-4.447,5.107-7.075c1.594-2.97,2.777-6.114,3.319-9.285C200.028,182.087,199.226,179.509,198.707,176.742z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__9_\" class=\"C1\" d=\"M186.623,177.992c-2.021-2.779-8.667-11.5-33.414-9.5\r\n\t\t\t\t\t\t\tc14.497,3,18.934,4.229,24.497,11.5c6.573,8.589,5,21.25,1.299,30.946c4.201-4.196,8.817-17.742,8.992-20.446\r\n\t\t\t\t\t\t\tC188.02,190.148,190.418,183.207,186.623,177.992z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"A_2_\">\r\n\t\t\t\t\t\t<path id=\"_x35__10_\" class=\"A5 A6\" d=\"M155.015,199.061c-1.346,1.696-2.699,4.09-3.082,6.282c-0.565,3.245,0.141,6.945,1.464,9.955c0.712,1.621,1.706,3.289,2.871,4.621\r\n\t\t\t\t\t\t\tc4.083,4.672,9.449,5.313,14.359,4.487c1.824-0.308,10.116-4.552,15.535-10.308c5.108-5.426,7.542-13.062,7.324-14.722\r\n\t\t\t\t\t\t\tc-0.633-4.825-10.417-11.75-21.693-9.707C167.624,190.664,157.677,195.717,155.015,199.061z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__10_\" class=\"A4\" d=\"M162.056,195.634c-1.26,0.649-2.5,1.723-3.412,2.813\r\n\t\t\t\t\t\t\tc-3.495,4.156-5.392,11.234-2.63,16.387c1.452,2.705,4.05,4.888,6.978,5.768c2.346,0.706,5.708,0.795,7.508,0.669\r\n\t\t\t\t\t\t\tc4.935-0.348,8.816-2.25,12.339-5.181c1.966-1.633,9.561-13.445,7.263-17.456c-3.939-6.874-11.264-7.87-19.204-7.146\r\n\t\t\t\t\t\t\tC169.468,191.619,163.324,194.982,162.056,195.634z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__10_\" class=\"A2\" d=\"M160.409,204.102c-2.748,6.689,2.47,12.956,8.816,14.438\r\n\t\t\t\t\t\t\tc4.486,1.048,9.001,0.267,12.402-2.697c3.259-2.842,5.417-12.176,2.708-17.21c-3.669-6.82-9.602-6.361-17.124-1.521\r\n\t\t\t\t\t\t\tC164.504,198.901,161.503,201.439,160.409,204.102z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__7_\" class=\"A1\" d=\"M169.667,198.742c-5.17,2.816-4.819,7.164-4.249,10.618\r\n\t\t\t\t\t\t\tc0.255,1.542,1.335,4.229,4.203,5.547c2.904,1.336,6.224,0.905,9.134,0.721c0.589-0.037,3.467-2.613,3.925-3.939\r\n\t\t\t\t\t\t\tc1.582-4.589,0.568-8.832-1.257-10.955C179.362,198.335,174.741,195.976,169.667,198.742z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x35__9_\" class=\"A5 A6\" d=\"M185.571,186.081\r\n\t\t\t\t\t\t\tc-1.641-0.136-3.254-0.523-4.871-0.87c-2.018-0.434-4.04-0.799-6.113-0.491c-2.375,0.349-5.432,2.116-7.226,3.834\r\n\t\t\t\t\t\t\tc-8.148,7.806-4.66,24.054,1.672,31.929c5.907,7.346,13.736,8.302,20.916,6.943c3.963-0.751,7.728-2.206,10.863-3.687\r\n\t\t\t\t\t\t\tc6.608-3.124,12.255-7.744,16.706-12.432c-6.748-9.785-14.535-18.669-17.858-30.689\r\n\t\t\t\t\t\t\tC195.465,183.845,190.711,186.5,185.571,186.081z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__9_\" class=\"A4\" d=\"M185.683,186.667c-1.639-0.133-3.254-0.524-4.87-0.87\r\n\t\t\t\t\t\t\tc-0.281,0.196-2.983,0.291-5.365,2.035c-4.732,3.466-7.936,8.543-8.891,13.63c-0.551,2.938,0.897,7.838,2.528,11.855\r\n\t\t\t\t\t\t\tc1.976,4.869,8.433,11.136,14.34,13.205c5.194,1.819,14.365-0.715,17.5-2.195c6.691-3.163,12.4-7.859,16.876-12.607\r\n\t\t\t\t\t\t\tc-6.708-9.799-14.527-18.644-17.983-30.552C195.613,184.414,190.843,187.091,185.683,186.667z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__9_\" class=\"A2\" d=\"M191.327,187.436c-4.221,1.462-6.278,1.819-9.05,3.366\r\n\t\t\t\t\t\t\tc-5.509,3.073-10.731,7.998-10.194,15.546c0.717,10.07,10.937,14.803,18.883,15.158c9.628,0.429,19.601-2.558,26.786-9.857\r\n\t\t\t\t\t\t\tc-6.543-9.545-14.135-18.189-17.697-29.659C197.266,184.269,194.533,186.328,191.327,187.436z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__6_\" class=\"A1\" d=\"M189.292,193.299c-6.375,3.642-18.344,10.194-6.584,17.338\r\n\t\t\t\t\t\t\tc4.572,2.779,10.035,3.313,15.125,3.745c6.151,0.521,12.417-1.883,18.285-5.08c-5.53-7.792-11.489-15.18-15.006-24.269\r\n\t\t\t\t\t\t\tC197.586,187.998,193.767,190.741,189.292,193.299z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x35__8_\" class=\"A5 A6\" d=\"M187.869,188.446\r\n\t\t\t\t\t\t\tc-1.823,2.155-3.654,5.2-4.171,7.99c-0.766,4.127,0.19,8.835,1.981,12.663c0.964,2.063,2.31,4.184,3.887,5.878\r\n\t\t\t\t\t\t\tc5.529,5.943,12.794,6.759,19.441,5.71c2.469-0.391,13.697-5.79,21.033-13.112c6.917-6.903,10.211-16.618,9.917-18.728\r\n\t\t\t\t\t\t\tc-0.857-6.139-14.104-14.946-29.37-12.35C204.941,177.76,191.473,184.192,187.869,188.446z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__8_\" class=\"A4\" d=\"M197.402,184.085c-1.706,0.825-3.384,2.19-4.62,3.576\r\n\t\t\t\t\t\t\tc-4.731,5.287-7.299,14.291-3.56,20.845c1.966,3.443,5.484,6.218,9.447,7.338c3.177,0.898,7.729,1.013,10.165,0.853\r\n\t\t\t\t\t\t\tc6.683-0.443,11.936-2.864,16.706-6.591c2.662-2.079,12.945-17.104,9.833-22.206c-5.333-8.744-15.25-10.01-26-9.09\r\n\t\t\t\t\t\t\tC207.438,178.975,199.119,183.254,197.402,184.085z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__8_\" class=\"A2\" d=\"M195.172,194.859c-3.722,8.507,3.344,16.48,11.937,18.365\r\n\t\t\t\t\t\t\tc6.073,1.332,12.187,0.34,16.791-3.433c4.413-3.614,7.333-15.487,3.667-21.892c-4.967-8.677-13-8.093-23.183-1.936\r\n\t\t\t\t\t\t\tC200.716,188.239,196.654,191.468,195.172,194.859z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__5_\" class=\"A1\" d=\"M207.707,188.037c-7,3.583-6.524,9.115-5.751,13.509\r\n\t\t\t\t\t\t\tc0.346,1.961,1.807,5.377,5.689,7.056c3.932,1.699,8.427,1.152,12.368,0.917c0.798-0.048,4.694-3.324,5.313-5.013\r\n\t\t\t\t\t\t\tc2.141-5.836,0.77-11.234-1.702-13.936C220.833,187.521,214.577,184.52,207.707,188.037z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"B_2_\">\r\n\t\t\t\t\t\t<path id=\"_x35__11_\" class=\"B5 B6\" d=\"M167.783,148.325\r\n\t\t\t\t\t\t\tc-0.313-0.062,12.722-0.874,14.898-1.038c13.28-0.994,21.19-1.25,34.312,1.012c10.375,1.79,19.861,8.834,23.756,18.924\r\n\t\t\t\t\t\t\tc3.482,9.024,2.907,21.367-3.129,29.717c-6.269,8.672-17.626,8.276-24.506,1.629c-2.953-2.853-5.465-6.952-4.409-11.445\r\n\t\t\t\t\t\t\tc1.155-4.909,3.409-8.091,7.383-10.618c1.208-0.767,3.22-2.041,5.592-2.29c-1.936-6.549-3.756-10.404-9.572-12.783\r\n\t\t\t\t\t\t\tC203.811,158.038,184.458,151.592,167.783,148.325z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__11_\" class=\"B4\" d=\"M171.217,148.647c13.063-2.823,37.064-2.081,46.814,1.021\r\n\t\t\t\t\t\t\tc9.745,3.101,14.067,9.361,16.503,13.097c1.341,2.055,2.489,4.349,3.201,6.714c1.812,6.017,1.267,12.039,0.85,14.68\r\n\t\t\t\t\t\t\tc-0.561,3.554-2.377,6.955-4.494,9.602c-1.891,2.363-7.072,6.568-12.589,5.541c-3.072-0.574-7.282-2.42-9.124-4.949\r\n\t\t\t\t\t\t\tc-3.077-4.225-1.51-9.32,1.76-13.794c2.861-3.914,11.025-5.529,13.242-1.101c1.4,2.798,0.67,9.221-2.563,10.745\r\n\t\t\t\t\t\t\tc-0.984,0.465-3.112,0.45-3.99,0.288c1.127,1.695,2.13,2.192,4.08,2.206c3.549,0.026,6.362-6.481,5.964-8.958\r\n\t\t\t\t\t\t\tc-0.358-2.237-2.259-5.884-3.869-7.71c-1.333-1.513-5.323-1.814-5.323-1.814s0.202-3.915-0.875-5.313\r\n\t\t\t\t\t\t\tc-1.263-1.646-1.634-3.177-3.217-4.489c-1.822-1.509-3.213-2.378-5.34-3.462c-0.606-0.31-5.417-2-8.458-3.298\r\n\t\t\t\t\t\t\tC202.084,156.924,176.853,150.275,171.217,148.647z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__11_\" class=\"B2\" d=\"M221.63,174.498c2.333,0.483,6.844,2.782,7.598,3.942\r\n\t\t\t\t\t\t\tc1.015,1.558,1.099,3.754,1.645,5.299c4.471-7.311-1.848-19.848-6.782-23.839c-2.895-2.34-7.852-5.409-11.544-6.095\r\n\t\t\t\t\t\t\tc-4.064-0.754-38.306-6.658-39.724-4.705c2.918,0.921,16.514,4.107,21.175,5.363c4.395,1.184,8.69,3.029,12.522,4.289\r\n\t\t\t\t\t\t\tC221.94,163.825,221.039,171.432,221.63,174.498z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__8_\" class=\"B1\" d=\"M193.998,154.463c2.277,0.55,11.731,3.173,15.561,4.43\r\n\t\t\t\t\t\t\tc6.521,2.14,11.163,7.821,11.872,12.821l1.042,2.833c2.167,0.483,4.619,1.828,7,4.833c0.453-0.47,0.618-2.557,0.48-3.179\r\n\t\t\t\t\t\t\tc-0.701-3.193-1.046-5.549-2.979-8.59c-0.681-1.072-1.668-1.89-2.602-2.738c-2.44-2.217-4.908-4.1-8.103-6.021\r\n\t\t\t\t\t\t\tc-1.08-0.649-3.289-1.594-4.445-2.096c-0.846-0.37-26.632-8.162-38.018-7.238C179.063,150.513,191.441,153.847,193.998,154.463\r\n\t\t\t\t\t\t\tz\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t</g>\r\n\t\t\t\t<g id=\"L_1_\">\r\n\t\t\t\t\t<g>\r\n\t\t\t\t\t\t<path id=\"_x35__35_\" class=\"C5 C6\" d=\"M75.36,172.538\r\n\t\t\t\t\t\t\tc2.196-16.019,29.779-26.115,47.234-24.857c16.941,1.22,40.407,10.212,51.691,22.688c0,0-36.295,18.041-39.787,36.298\r\n\t\t\t\t\t\t\tc-1.104,5.775-4.91,10.67-7.394,15.995c-0.231,0.497-8.436-0.295-13.913-4.958c-9.478-8.068-18.435-13.729-25.281-19.278\r\n\t\t\t\t\t\t\tc4.699-6.438,8.811-13.219,10.397-21.683c-1.587,8.464-5.698,15.244-10.397,21.683C79.073,191.26,73.75,184.279,75.36,172.538z\r\n\t\t\t\t\t\t\t\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__35_\" class=\"C4\" d=\"M98.308,176.742c-1.313,7.004-4.351,12.857-8.023,18.317\r\n\t\t\t\t\t\t\tc-0.531-0.552-0.902-0.979-1.025-1.203c-2.842-5.201-4.541-11.428-3.811-17.53c1.184-9.885,13.766-18.253,25.918-19.755\r\n\t\t\t\t\t\t\tc14.489-1.791,25.354-0.281,41.508,8.37c4.466,2.393,8.892,4.949,11.567,8.569c-6.048,1.022-8.746,0.103-13.998,2.152\r\n\t\t\t\t\t\t\tc-5.762,2.249-15.423,9.826-18.469,14.256c-5.999,8.72-5.031,15.079-10.299,24.259c-2.268,3.955-6.509,0.704-13.958-4.505\r\n\t\t\t\t\t\t\tc-6.232-4.356-14.532-11.597-17.435-14.613C93.957,189.599,96.994,183.746,98.308,176.742z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__35_\" class=\"C2\" d=\"M98.308,176.742c-0.519,2.768-1.321,5.346-2.312,7.8\r\n\t\t\t\t\t\t\tc-0.938-5.484,0.055-11.05,4.244-15.939c5.279-6.16,13.451-9.092,21.193-9.185c7.829-0.095,15.044,1.741,22.102,4.869\r\n\t\t\t\t\t\t\tc3.883,1.722,8.239,4.671,12.389,5.615c0,0-4.673-1.067-10.483,0.703c-5.542,1.691-11.938,7.304-15.182,10.947\r\n\t\t\t\t\t\t\tc-7.674,8.637-6.698,21.182-11.695,31.144c-0.811,0.291-5.524-4.202-6.263-4.772c-2.809-2.162-5.502-4.441-7.877-7.021\r\n\t\t\t\t\t\t\tc-1.956-2.122-3.697-4.447-5.107-7.075c-1.594-2.97-2.777-6.114-3.319-9.285C96.986,182.087,97.789,179.509,98.308,176.742z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__27_\" class=\"C1\" d=\"M110.391,177.992c2.021-2.779,8.667-11.5,33.414-9.5\r\n\t\t\t\t\t\t\tc-14.497,3-18.934,4.229-24.497,11.5c-6.573,8.589-5,21.25-1.299,30.946c-4.201-4.196-8.817-17.742-8.992-20.446\r\n\t\t\t\t\t\t\tC108.994,190.148,106.596,183.207,110.391,177.992z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"A_7_\">\r\n\t\t\t\t\t\t<path id=\"_x35__34_\" class=\"A5 A6\" d=\"M142,199.061\r\n\t\t\t\t\t\t\tc1.346,1.696,2.699,4.09,3.082,6.282c0.564,3.245-0.141,6.945-1.464,9.955c-0.712,1.621-1.706,3.289-2.871,4.621\r\n\t\t\t\t\t\t\tc-4.083,4.672-9.449,5.313-14.359,4.487c-1.824-0.308-10.116-4.552-15.535-10.308c-5.108-5.426-7.542-13.062-7.324-14.722\r\n\t\t\t\t\t\t\tc0.633-4.825,10.417-11.75,21.693-9.707C129.39,190.664,139.337,195.717,142,199.061z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__34_\" class=\"A4\" d=\"M134.958,195.634c1.26,0.649,2.5,1.723,3.412,2.813\r\n\t\t\t\t\t\t\tc3.495,4.156,5.392,11.234,2.63,16.387c-1.452,2.705-4.05,4.888-6.978,5.768c-2.346,0.706-5.708,0.795-7.508,0.669\r\n\t\t\t\t\t\t\tc-4.935-0.348-8.816-2.25-12.339-5.181c-1.966-1.633-9.561-13.445-7.263-17.456c3.939-6.874,11.264-7.87,19.204-7.146\r\n\t\t\t\t\t\t\tC127.546,191.619,133.69,194.982,134.958,195.634z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__34_\" class=\"A2\" d=\"M136.605,204.102c2.748,6.689-2.47,12.956-8.816,14.438\r\n\t\t\t\t\t\t\tc-4.486,1.048-9.001,0.267-12.402-2.697c-3.259-2.842-5.417-12.176-2.708-17.21c3.669-6.82,9.602-6.361,17.124-1.521\r\n\t\t\t\t\t\t\tC132.51,198.901,135.511,201.439,136.605,204.102z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__26_\" class=\"A1\" d=\"M127.347,198.742c5.17,2.816,4.819,7.164,4.249,10.618\r\n\t\t\t\t\t\t\tc-0.255,1.542-1.335,4.229-4.203,5.547c-2.904,1.336-6.224,0.905-9.134,0.721c-0.589-0.037-3.467-2.613-3.925-3.939\r\n\t\t\t\t\t\t\tc-1.582-4.589-0.568-8.832,1.257-10.955C117.652,198.335,122.273,195.976,127.347,198.742z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x35__33_\" class=\"A5 A6\" d=\"M111.443,186.081\r\n\t\t\t\t\t\t\tc1.641-0.136,3.254-0.523,4.871-0.87c2.018-0.434,4.04-0.799,6.113-0.491c2.375,0.349,5.432,2.116,7.226,3.834\r\n\t\t\t\t\t\t\tc8.148,7.806,4.66,24.054-1.672,31.929c-5.907,7.346-13.736,8.302-20.916,6.943c-3.963-0.751-7.728-2.206-10.863-3.687\r\n\t\t\t\t\t\t\tc-6.608-3.124-12.255-7.744-16.706-12.432c6.748-9.785,14.535-18.669,17.858-30.689\r\n\t\t\t\t\t\t\tC101.549,183.845,106.303,186.5,111.443,186.081z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__33_\" class=\"A4\" d=\"M111.331,186.667c1.639-0.133,3.254-0.524,4.87-0.87\r\n\t\t\t\t\t\t\tc0.281,0.196,2.983,0.291,5.365,2.035c4.732,3.466,7.936,8.543,8.891,13.63c0.551,2.938-0.897,7.838-2.528,11.855\r\n\t\t\t\t\t\t\tc-1.976,4.869-8.433,11.136-14.34,13.205c-5.194,1.819-14.365-0.715-17.5-2.195c-6.691-3.163-12.4-7.859-16.876-12.607\r\n\t\t\t\t\t\t\tc6.708-9.799,14.527-18.644,17.983-30.552C101.401,184.414,106.171,187.091,111.331,186.667z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__33_\" class=\"A2\" d=\"M105.687,187.436c4.221,1.462,6.278,1.819,9.05,3.366\r\n\t\t\t\t\t\t\tc5.509,3.073,10.731,7.998,10.194,15.546c-0.717,10.07-10.937,14.803-18.883,15.158c-9.628,0.429-19.601-2.558-26.786-9.857\r\n\t\t\t\t\t\t\tc6.543-9.545,14.135-18.189,17.697-29.659C99.749,184.269,102.481,186.328,105.687,187.436z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__25_\" class=\"A1\" d=\"M107.723,193.299c6.375,3.642,18.344,10.194,6.584,17.338\r\n\t\t\t\t\t\t\tc-4.572,2.779-10.035,3.313-15.125,3.745c-6.151,0.521-12.417-1.883-18.285-5.08c5.53-7.792,11.489-15.18,15.006-24.269\r\n\t\t\t\t\t\t\tC99.428,187.998,103.247,190.741,107.723,193.299z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x35__32_\" class=\"A5 A6\" d=\"M109.146,188.446\r\n\t\t\t\t\t\t\tc1.823,2.155,3.654,5.2,4.171,7.99c0.766,4.127-0.19,8.835-1.981,12.663c-0.964,2.063-2.31,4.184-3.887,5.878\r\n\t\t\t\t\t\t\tc-5.529,5.943-12.794,6.759-19.441,5.71c-2.469-0.391-13.697-5.79-21.033-13.112c-6.917-6.903-10.211-16.618-9.917-18.728\r\n\t\t\t\t\t\t\tc0.857-6.139,14.104-14.946,29.37-12.35C92.073,177.76,105.541,184.192,109.146,188.446z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__32_\" class=\"A4\" d=\"M99.612,184.085c1.706,0.825,3.384,2.19,4.62,3.576\r\n\t\t\t\t\t\t\tc4.731,5.287,7.299,14.291,3.56,20.845c-1.966,3.443-5.484,6.218-9.447,7.338c-3.177,0.898-7.729,1.013-10.165,0.853\r\n\t\t\t\t\t\t\tc-6.683-0.443-11.936-2.864-16.706-6.591c-2.662-2.079-12.945-17.104-9.833-22.206c5.333-8.744,15.25-10.01,26-9.09\r\n\t\t\t\t\t\t\tC89.576,178.975,97.895,183.254,99.612,184.085z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__32_\" class=\"A2\" d=\"M101.842,194.859c3.722,8.507-3.344,16.48-11.937,18.365\r\n\t\t\t\t\t\t\tc-6.073,1.332-12.187,0.34-16.791-3.433c-4.413-3.614-7.333-15.487-3.667-21.892c4.967-8.677,13-8.093,23.183-1.936\r\n\t\t\t\t\t\t\tC96.298,188.239,100.36,191.468,101.842,194.859z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__24_\" class=\"A1\" d=\"M89.308,188.037c7,3.583,6.524,9.115,5.751,13.509\r\n\t\t\t\t\t\t\tc-0.346,1.961-1.807,5.377-5.689,7.056c-3.932,1.699-8.427,1.152-12.368,0.917c-0.798-0.048-4.694-3.324-5.313-5.013\r\n\t\t\t\t\t\t\tc-2.141-5.836-0.77-11.234,1.702-13.936C76.182,187.521,82.437,184.52,89.308,188.037z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"B_7_\">\r\n\t\t\t\t\t\t<path id=\"_x35__31_\" class=\"B5 B6\" d=\"M129.231,148.325\r\n\t\t\t\t\t\t\tc0.313-0.062-12.722-0.874-14.898-1.038c-13.28-0.994-21.19-1.25-34.312,1.012c-10.375,1.79-19.861,8.834-23.756,18.924\r\n\t\t\t\t\t\t\tc-3.482,9.024-2.907,21.367,3.129,29.717c6.269,8.672,17.626,8.276,24.506,1.629c2.953-2.853,5.465-6.952,4.409-11.445\r\n\t\t\t\t\t\t\tc-1.155-4.909-3.409-8.091-7.383-10.618c-1.208-0.767-3.22-2.041-5.592-2.29c1.936-6.549,3.756-10.404,9.572-12.783\r\n\t\t\t\t\t\t\tC93.203,158.038,112.556,151.592,129.231,148.325z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__31_\" class=\"B4\" d=\"M125.797,148.647c-13.063-2.823-37.064-2.081-46.814,1.021\r\n\t\t\t\t\t\t\tc-9.745,3.101-14.067,9.361-16.503,13.097c-1.341,2.055-2.489,4.349-3.201,6.714c-1.812,6.017-1.267,12.039-0.85,14.68\r\n\t\t\t\t\t\t\tc0.561,3.554,2.377,6.955,4.494,9.602c1.891,2.363,7.072,6.568,12.589,5.541c3.072-0.574,7.282-2.42,9.124-4.949\r\n\t\t\t\t\t\t\tc3.077-4.225,1.51-9.32-1.76-13.794c-2.861-3.914-11.025-5.529-13.242-1.101c-1.4,2.798-0.67,9.221,2.563,10.745\r\n\t\t\t\t\t\t\tc0.984,0.465,3.112,0.45,3.99,0.288c-1.127,1.695-2.13,2.192-4.08,2.206c-3.549,0.026-6.362-6.481-5.964-8.958\r\n\t\t\t\t\t\t\tc0.358-2.237,2.259-5.884,3.869-7.71c1.333-1.513,5.323-1.814,5.323-1.814s-0.202-3.915,0.875-5.313\r\n\t\t\t\t\t\t\tc1.263-1.646,1.634-3.177,3.217-4.489c1.822-1.509,3.213-2.378,5.34-3.462c0.606-0.31,5.417-2,8.458-3.298\r\n\t\t\t\t\t\t\tC94.93,156.924,120.161,150.275,125.797,148.647z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__31_\" class=\"B2\" d=\"M75.384,174.498c-2.333,0.483-6.844,2.782-7.598,3.942\r\n\t\t\t\t\t\t\tc-1.015,1.558-1.099,3.754-1.645,5.299c-4.471-7.311,1.848-19.848,6.782-23.839c2.895-2.34,7.852-5.409,11.544-6.095\r\n\t\t\t\t\t\t\tc4.064-0.754,38.306-6.658,39.724-4.705c-2.918,0.921-16.514,4.107-21.175,5.363c-4.395,1.184-8.69,3.029-12.522,4.289\r\n\t\t\t\t\t\t\tC75.074,163.825,75.976,171.432,75.384,174.498z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__23_\" class=\"B1\" d=\"M103.017,154.463c-2.277,0.55-11.731,3.173-15.561,4.43\r\n\t\t\t\t\t\t\tc-6.521,2.14-11.163,7.821-11.872,12.821l-1.042,2.833c-2.167,0.483-4.619,1.828-7,4.833c-0.453-0.47-0.618-2.557-0.48-3.179\r\n\t\t\t\t\t\t\tc0.701-3.193,1.046-5.549,2.979-8.59c0.681-1.072,1.668-1.89,2.602-2.738c2.44-2.217,4.908-4.1,8.103-6.021\r\n\t\t\t\t\t\t\tc1.08-0.649,3.289-1.594,4.445-2.096c0.846-0.37,26.632-8.162,38.018-7.238C117.951,150.513,105.573,153.847,103.017,154.463z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t</g>\r\n\t\t\t</g>\r\n\t\t\t<g id=\"Mid\">\r\n\t\t\t\t<g id=\"R_1_\">\r\n\t\t\t\t\t<g id=\"C_1_\">\r\n\t\t\t\t\t\t<path id=\"_x35__7_\" class=\"C5 C6\" d=\"M272.207,183.492\r\n\t\t\t\t\t\t\tc3.339-3.836,7.661-9.005,10.295-13.5c10.147-17.319,15.412-41.499-9.187-56c-16.34-9.633-27.458-7.629-38.858-6\r\n\t\t\t\t\t\t\tc-12.25,1.75-24.907,7.673-33.5,16.25c-4.675,4.665-9.719,11.36-12.75,17.25c-3.206,6.229-2.524,13.146,0.107,19.766\r\n\t\t\t\t\t\t\tc11.423-6.379,23.165-15.028,36.129-17.811c15.622-3.353,27.33,6.862,32.561,20.924c3.393,9.123,4.29,18.921,5.167,28.54\r\n\t\t\t\t\t\t\tC267.38,189.086,267.008,189.465,272.207,183.492z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__7_\" class=\"C4\" d=\"M275.479,172.214c7.563-13.978,11.245-32.175-0.606-44.246\r\n\t\t\t\t\t\t\tc-3.64-3.707-8.165-7.007-12.636-9.643c-13.536-7.979-30.902-8.946-45.24-2.561c-4.143,1.846-8.027,4.527-11.278,7.696\r\n\t\t\t\t\t\t\tc-4.442,4.329-9.164,9.995-12.012,15.53c-1.613,3.134-2.456,6.511-2.64,10.02c-0.052,0.993,0.469,6.018-0.36,6.48\r\n\t\t\t\t\t\t\tc9.139-5.103,22.628-13.024,33-15.25c14.521-3.117,27.675,6.617,31.75,12c5.512,7.28,9.915,26.333,10.5,32.75\r\n\t\t\t\t\t\t\tc-0.03-0.33,3.612-3.636,4.062-4.234C271.944,178.191,273.806,175.306,275.479,172.214z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__7_\" class=\"C2\" d=\"M273.168,160.281c0.252-4.563,0.164-9.137-0.144-13.377\r\n\t\t\t\t\t\t\tc-0.732-10.094-5.182-19.632-14.112-24.896c-7.554-4.453-16.46-6.533-25.19-6.469c-7.195,0.053-13.854,2.875-19.751,6.828\r\n\t\t\t\t\t\t\tc-5.526,3.704-11.682,8.064-14.964,14.312c0.11-0.22,0.217-0.442,0.333-0.658c-2.046,4.066-5.176,9.354-5.135,14.013\r\n\t\t\t\t\t\t\tc7.311-4.082,25.703-14.761,34-16.541c11.617-2.493,26.24,10.186,29.5,14.492c4.41,5.824,10.033,25.373,10.5,30.507\r\n\t\t\t\t\t\t\tc0.055,0.598,2.443-2.599,2.587-3.095C272.149,170.711,272.88,165.502,273.168,160.281z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__4_\" class=\"C1\" d=\"M263,140.72c-5.767-11.47-19.843-18.673-32.293-18.034\r\n\t\t\t\t\t\t\tc-12.492,0.641-27.589,8.204-31.567,21.024c-0.096,0.087-0.102,0.082-0.019-0.015c5.017-5.879,12.419-9.381,19.548-11.964\r\n\t\t\t\t\t\t\tc7.628-2.764,15.979-5.104,23.983-2.435c7.005,2.335,13.941,8.687,17.349,15.229c1.068,2.051,1.75,5.692,4.752,5.459\r\n\t\t\t\t\t\t\tC265.818,147.177,264.296,143.3,263,140.72z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"B_1_\">\r\n\t\t\t\t\t\t<path id=\"_x35__6_\" class=\"B5 B6\" d=\"M245.345,136.61\r\n\t\t\t\t\t\t\tc-1.331,1.415-2.404,3.019-3.226,4.446c-3.545,6.164-3.925,13.352-3.487,16.668c0.232,1.753,1.092,5.907,2.252,8.499\r\n\t\t\t\t\t\t\tc0.99,2.208,2.964,5.031,3.347,5.482c0.553,0.651,5.619,6.012,8.225,7.346c-0.578-3.921-1.741-7.458-1.34-11.504\r\n\t\t\t\t\t\t\tc0.321-3.247,1.205-6.474,2.04-9.623c0.792-2.988,1.902-6.402,4.641-8.171c0.667-0.43,1.39-0.764,2.103-1.112\r\n\t\t\t\t\t\t\tc0.891-0.437,1.764-0.897,2.484-1.607c0.824-0.813,1.541-2.318,1.785-3.44c1.107-5.092-4.465-9.742-8.957-10.646\r\n\t\t\t\t\t\t\tC251.023,132.104,247.758,134.047,245.345,136.61z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__6_\" class=\"B4\" d=\"M261.949,147.198c0.92-2.585,0.834-5.287-0.123-7.34\r\n\t\t\t\t\t\t\tc-0.553-1.185-2.386-2.472-4.061-3.397c-2.029-1.123-6.147-1.431-8.961-0.434c-2.476,0.877-5.349,4.428-6.17,5.856\r\n\t\t\t\t\t\t\tc-3.547,6.165-3.925,13.352-3.487,16.668c0.23,1.754,1.091,5.907,2.252,8.499c0.989,2.209,2.963,5.032,3.346,5.483\r\n\t\t\t\t\t\t\tc0.552,0.651,5.619,6.012,8.225,7.345c-0.579-3.92-1.742-7.456-1.341-11.503c0.32-3.248,1.205-6.474,2.04-9.623\r\n\t\t\t\t\t\t\tc0.792-2.988,1.902-6.404,4.64-8.171c0.667-0.431,1.391-0.765,2.104-1.113C260.469,149.319,261.484,148.5,261.949,147.198z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__6_\" class=\"B2\" d=\"M254.483,148.319c1.506-3.124,4.509-8.062-1.978-7.961\r\n\t\t\t\t\t\t\tc-2.509,0.039-5.227,0.935-7.3,2.265c-3.519,2.259-5.128,7.423-6.806,11.364c-0.111,4.134,0.747,8.386,2.479,12.058\r\n\t\t\t\t\t\t\tc1.177,2.495,2.838,5.294,4.777,7.278c2.087,2.138,4.395,4.008,6.819,5.748c-1.361-5.69-2.797-11.835-1.886-17.411\r\n\t\t\t\t\t\t\tC251.343,157.037,252.243,152.96,254.483,148.319z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__3_\" class=\"B1\" d=\"M242.4,153.206c0.578-2.179,1.185-3.933,2.381-5.846\r\n\t\t\t\t\t\t\tc1.142-1.827,3.87-4.097,6.045-4.639c1.121-0.278,2.625-0.012,2.551,1.397c-0.058,1.101-1.87,2.024-2.643,2.616\r\n\t\t\t\t\t\t\tc-4.652,3.563-3.417,12.679-4.695,13.691C246.039,160.426,242.088,154.379,242.4,153.206z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x35__5_\" class=\"B5 B6\" d=\"M265.111,157.147\r\n\t\t\t\t\t\t\tc1.564-1.875,2.329-4.396,2.433-6.81c0.051-1.215-0.123-2.742-0.667-3.848c-0.805-1.635-2.326-3.038-3.899-3.921\r\n\t\t\t\t\t\t\tc-0.847-0.476-1.835-0.876-2.792-1.068c-3.35-0.675-5.962,0.88-7.892,2.931c-1.065,1.132-5.753,6.261-4.98,13.568\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__5_\" class=\"B4\" d=\"M247.552,157.141c0.231-0.47,0.285-1.247,0.422-1.821\r\n\t\t\t\t\t\t\tc0.14-0.59,0.343-1.129,0.501-1.709c0.921-3.372,2.326-5.564,4.896-7.829c0.765-0.673,2.299-1.786,3.581-2.278\r\n\t\t\t\t\t\t\tc1.598-0.612,3.473-0.534,5.004,0.17c2.916,1.341,4.373,5.137,4.162,8.184c-0.055,0.795-0.26,1.697-0.611,2.418\r\n\t\t\t\t\t\t\tc-0.361,0.737-0.549,1.724-1.139,2.298c-0.494,0.479-1.122,0.967-1.789,1.533\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__5_\" class=\"B2\" d=\"M248.254,159.132c-0.175-0.385-0.146-0.928-0.175-1.342\r\n\t\t\t\t\t\t\tc-0.114-1.622-0.062-3.411,0.544-4.943c0.5-1.265,1.516-2.23,2.521-3.104c1.243-1.08,3.028-2.711,4.732-2.652\r\n\t\t\t\t\t\t\tc0.795,0.026,1.784,0.427,2.4,1.023c1.381,1.34,1.907,3.308,1.11,5.004c-0.204,0.436-0.479,0.873-0.784,1.245\r\n\t\t\t\t\t\t\tc-0.326,0.399-0.68,0.79-1.054,1.145c-0.974,0.926-1.995,1.865-2.507,3.133c-0.208,0.51-0.395,1.057-0.541,1.584\r\n\t\t\t\t\t\t\tc-0.124,0.446-0.214,1.002-0.07,1.454\"></path>\r\n\t\t\t\t\t\t<path id=\"_x35__4_\" class=\"B5 B6\" d=\"M253.186,172.511\r\n\t\t\t\t\t\t\tc-0.021-0.08-0.147-0.589-0.033-0.156c1.171,4.746,6.237,7.623,10.923,6.424c4.641-1.188,8.021-5.627,7.963-10.537\r\n\t\t\t\t\t\t\tc-0.03-2.511-0.464-5.109-1.366-7.334c-0.858-2.118-3.275-3.659-4.763-5.341c-4.621-5.225-9.766-2.105-15.704-2.158\r\n\t\t\t\t\t\t\tc-5.382-0.048-10.005,3.907-12.891,8.091c-5.354,7.763-6.063,22.329,0.237,29.804c6.995,8.299,18.861,11.573,29.319,9.401\r\n\t\t\t\t\t\t\tc2.064-0.429,4.144-1.076,5.892-2.288c1.734-1.203,2.818-3.196,4.656-4.237c1.58-0.895,3.548-0.765,5.16-1.618\r\n\t\t\t\t\t\t\tc1.594-0.844,2.972-2.158,4.153-3.492c8.607-9.717,6.893-22.191,6.306-34.16c-0.132-2.69-0.697-5.081-0.666-7.668\r\n\t\t\t\t\t\t\tc0.034-2.838-0.296-5.687-0.933-8.453c-0.39-1.692-0.558-5.072-2.259-5.94c0.466,0.237,0.336,6.052,0.366,6.641\r\n\t\t\t\t\t\t\tc0.206,4.017,0.532,8.08-0.053,12.08c-1.561,10.669-10.932,20.248-19.91,25.554c-1.069,0.632-2.232,0.91-3.379,1.494\r\n\t\t\t\t\t\t\tC260.566,181.489,254.698,178.266,253.186,172.511z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__4_\" class=\"B4\" d=\"M254.387,173.724c5.569,3.115,18.266-1.076,13.819-11.465\r\n\t\t\t\t\t\t\tc-2-4.673-14.375-8.807-21.625-4.673c-8.332,4.75-12.282,15.736-10.5,23.655c1.125,5,7.377,12.109,10.125,13.613\r\n\t\t\t\t\t\t\tc13.5,7.387,24.859,0.889,29.75-1.988c6.452-3.796,12.125-10,14.402-17.167c1.048-3.299,0.348-17.609-0.902-20.085\r\n\t\t\t\t\t\t\tc-0.875,4.306-11.943,16.237-13.561,17.646c-1.755,1.528-4.015,2.771-6.051,3.754c-2.417,1.168-5.153,1.637-7.787,1.871\r\n\t\t\t\t\t\t\tC258.668,179.188,254.885,176.672,254.387,173.724z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__4_\" class=\"B2\" d=\"M254.387,173.724c3.817,0.979,10.906-3.251,8.919-8.325\r\n\t\t\t\t\t\t\tc-2.115-5.397-9.541-3.924-13.401-2.107c-5.856,2.755-7.556,8.632-6.42,14.754c0.645,3.475,2.459,7.307,5.029,9.803\r\n\t\t\t\t\t\t\tc8.971,8.713,22.902,0.52,25.152-1.569c3.541-3.287,6.31-9.388,7.49-12.415c0.601-1.539,0.825-4.817,0.825-7.107\r\n\t\t\t\t\t\t\tc-2.015,2.621-3.525,4.179-5.143,5.588c-1.755,1.528-11.561,6.308-14.194,6.542\r\n\t\t\t\t\t\t\tC259.254,179.188,256.114,177.67,254.387,173.724z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"A_1_\">\r\n\t\t\t\t\t\t<path class=\"A5 A6\" d=\"M199.207,133.239c-0.583-4.497,0.833-13.803,4.25-17.217\r\n\t\t\t\t\t\t\tc3.775-3.772,9.654-8.961,14.888-10.577c6.476-2,13.525-3.791,19.946-4.873c7.843-1.322,15.278-2.188,23.078-1.572\r\n\t\t\t\t\t\t\tc4.831,0.382,9.547,2.33,13.438,5.184c5.257,3.857,9.228,10.839,8.508,17.365c-0.747,6.779-7.736,10.189-14.209,8.727\r\n\t\t\t\t\t\t\tc-4.022-0.908-7.05-3.888-7.174-8.055c-0.156-5.289,2.865-5.727,6.619-8.229c0.238-0.159-2.094-3.913-4.24-4.335\r\n\t\t\t\t\t\t\tc-2.303-0.453-7.021-0.973-9.354-1c-6.92-0.081-13.599,0.953-20.496,1.83c-5.486,0.697-10.328,1.719-15.504,3.506\r\n\t\t\t\t\t\t\tc-5.305,1.831-9.25,5.747-13.583,10.58C203.861,126.258,200.623,130.072,199.207,133.239z\"></path>\r\n\t\t\t\t\t\t<path class=\"A4\" d=\"M200.457,129.017c0.131-1.241,1.015-9.53,1.75-10.611c3.861-5.675,9.148-9.971,14.238-12.235\r\n\t\t\t\t\t\t\tc2.38-1.06,5.031-1.705,7.2-2.276c7.425-1.955,19.192-4.15,21.552-4.353c7.083-0.609,18.124-0.744,24.009,1.753\r\n\t\t\t\t\t\t\tc1.548,0.656,5.688,2.899,6.945,3.974c3.197,2.736,4.694,7.137,5.367,8.724c0.903,2.137,0.162,5.157-0.189,7.291\r\n\t\t\t\t\t\t\tc-0.313,1.907-1.967,5.876-5.653,7.072c-2.053,0.666-5.239,0.993-7.233,0.189c-3.334-1.344-6.204-4.013-4.231-10.109\r\n\t\t\t\t\t\t\tc1.147-3.546,5.183-4.616,8.067-2.886c1.824,1.094,3.63,4.864,2.215,6.736c-0.433,0.57-1.721,1.242-2.308,1.434\r\n\t\t\t\t\t\t\tc1.273,0.573,2.053,0.527,3.233-0.088c2.148-1.12,1.569-5.603,0.463-6.84c-0.998-1.118-2.816-3.145-4.426-3.636\r\n\t\t\t\t\t\t\tc-1.333-0.407-1.92-1.556-2.333-2.167c-0.492-0.729-3.027-2.57-4.167-2.997c-3.179-1.193-6.606-1.229-9.956-1.206\r\n\t\t\t\t\t\t\tc-2.675,0.019-5.354-0.095-8.026,0.06c-2.595,0.149-9.466,0.752-12.393,1.146c-2.065,0.278-8.207,1.752-10.266,2.073\r\n\t\t\t\t\t\t\tc-1.52,0.236-6.507,2.061-7.871,2.802c-5.238,2.848-7.043,4.497-10.788,9.263c-1.224,1.558-2.42,3.137-3.634,4.702\r\n\t\t\t\t\t\t\tC201.499,127.508,200.821,128.231,200.457,129.017z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t</g>\r\n\t\t\t\t<g id=\"L_2_\">\r\n\t\t\t\t\t<g id=\"C_3_\">\r\n\t\t\t\t\t\t<path id=\"_x35__26_\" class=\"C5 C6\" d=\"M24.808,183.492\r\n\t\t\t\t\t\t\tc-3.339-3.836-7.661-9.005-10.295-13.5c-10.147-17.319-15.412-41.499,9.187-56c16.34-9.633,27.458-7.629,38.858-6\r\n\t\t\t\t\t\t\tc12.25,1.75,24.907,7.673,33.5,16.25c4.675,4.665,9.719,11.36,12.75,17.25c3.206,6.229,2.524,13.146-0.107,19.766\r\n\t\t\t\t\t\t\tc-11.423-6.379-23.165-15.028-36.129-17.811c-15.622-3.353-27.33,6.862-32.561,20.924c-3.393,9.123-4.29,18.921-5.167,28.54\r\n\t\t\t\t\t\t\tC29.634,189.086,30.006,189.465,24.808,183.492z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__26_\" class=\"C4\" d=\"M21.535,172.214c-7.563-13.978-11.245-32.175,0.606-44.246\r\n\t\t\t\t\t\t\tc3.64-3.707,8.165-7.007,12.636-9.643c13.536-7.979,30.902-8.946,45.24-2.561c4.143,1.846,8.027,4.527,11.278,7.696\r\n\t\t\t\t\t\t\tc4.442,4.329,9.164,9.995,12.012,15.53c1.613,3.134,2.456,6.511,2.64,10.02c0.052,0.993-0.469,6.018,0.36,6.48\r\n\t\t\t\t\t\t\tc-9.139-5.103-22.628-13.024-33-15.25c-14.521-3.117-27.675,6.617-31.75,12c-5.512,7.28-9.915,26.333-10.5,32.75\r\n\t\t\t\t\t\t\tc0.03-0.33-3.612-3.636-4.062-4.234C25.07,178.191,23.208,175.306,21.535,172.214z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__26_\" class=\"C2\" d=\"M23.846,160.281c-0.252-4.563-0.164-9.137,0.144-13.377\r\n\t\t\t\t\t\t\tc0.732-10.094,5.182-19.632,14.112-24.896c7.554-4.453,16.46-6.533,25.19-6.469c7.195,0.053,13.854,2.875,19.751,6.828\r\n\t\t\t\t\t\t\tc5.526,3.704,11.682,8.064,14.964,14.312c-0.11-0.22-0.217-0.442-0.333-0.658c2.046,4.066,5.176,9.354,5.135,14.013\r\n\t\t\t\t\t\t\tc-7.311-4.082-25.703-14.761-34-16.541c-11.617-2.493-26.24,10.186-29.5,14.492c-4.41,5.824-10.033,25.373-10.5,30.507\r\n\t\t\t\t\t\t\tc-0.055,0.598-2.443-2.599-2.587-3.095C24.865,170.711,24.134,165.502,23.846,160.281z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__19_\" class=\"C1\" d=\"M34.015,140.72c5.767-11.47,19.843-18.673,32.293-18.034\r\n\t\t\t\t\t\t\tc12.492,0.641,27.589,8.204,31.567,21.024c0.096,0.087,0.102,0.082,0.019-0.015c-5.017-5.879-12.419-9.381-19.548-11.964\r\n\t\t\t\t\t\t\tc-7.628-2.764-15.979-5.104-23.983-2.435c-7.005,2.335-13.941,8.687-17.349,15.229c-1.068,2.051-1.75,5.692-4.752,5.459\r\n\t\t\t\t\t\t\tC31.196,147.177,32.718,143.3,34.015,140.72z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"B_5_\">\r\n\t\t\t\t\t\t<path id=\"_x35__25_\" class=\"B5 B6\" d=\"M51.669,136.61\r\n\t\t\t\t\t\t\tc1.331,1.415,2.404,3.019,3.226,4.446c3.545,6.164,3.925,13.352,3.487,16.668c-0.232,1.753-1.092,5.907-2.252,8.499\r\n\t\t\t\t\t\t\tc-0.99,2.208-2.964,5.031-3.347,5.482c-0.553,0.651-5.619,6.012-8.225,7.346c0.578-3.921,1.741-7.458,1.34-11.504\r\n\t\t\t\t\t\t\tc-0.321-3.247-1.205-6.474-2.04-9.623c-0.792-2.988-1.902-6.402-4.641-8.171c-0.667-0.43-1.39-0.764-2.103-1.112\r\n\t\t\t\t\t\t\tc-0.891-0.437-1.764-0.897-2.484-1.607c-0.824-0.813-1.541-2.318-1.785-3.44c-1.107-5.092,4.465-9.742,8.957-10.646\r\n\t\t\t\t\t\t\tC45.991,132.104,49.256,134.047,51.669,136.61z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__25_\" class=\"B4\" d=\"M35.065,147.198c-0.92-2.585-0.834-5.287,0.123-7.34\r\n\t\t\t\t\t\t\tc0.553-1.185,2.386-2.472,4.061-3.397c2.029-1.123,6.147-1.431,8.961-0.434c2.476,0.877,5.349,4.428,6.17,5.856\r\n\t\t\t\t\t\t\tc3.547,6.165,3.925,13.352,3.487,16.668c-0.23,1.754-1.091,5.907-2.252,8.499c-0.989,2.209-2.963,5.032-3.346,5.483\r\n\t\t\t\t\t\t\tc-0.552,0.651-5.619,6.012-8.225,7.345c0.579-3.92,1.742-7.456,1.341-11.503c-0.32-3.248-1.205-6.474-2.04-9.623\r\n\t\t\t\t\t\t\tc-0.792-2.988-1.902-6.404-4.64-8.171c-0.667-0.431-1.391-0.765-2.104-1.113C36.545,149.319,35.53,148.5,35.065,147.198z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__25_\" class=\"B2\" d=\"M42.531,148.319c-1.506-3.124-4.509-8.062,1.978-7.961\r\n\t\t\t\t\t\t\tc2.509,0.039,5.227,0.935,7.3,2.265c3.519,2.259,5.128,7.423,6.806,11.364c0.111,4.134-0.747,8.386-2.479,12.058\r\n\t\t\t\t\t\t\tc-1.177,2.495-2.838,5.294-4.777,7.278c-2.087,2.138-4.395,4.008-6.819,5.748c1.361-5.69,2.797-11.835,1.886-17.411\r\n\t\t\t\t\t\t\tC45.671,157.037,44.771,152.96,42.531,148.319z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__18_\" class=\"B1\" d=\"M54.614,153.206c-0.578-2.179-1.185-3.933-2.381-5.846\r\n\t\t\t\t\t\t\tc-1.142-1.827-3.87-4.097-6.045-4.639c-1.121-0.278-2.625-0.012-2.551,1.397c0.058,1.101,1.87,2.024,2.643,2.616\r\n\t\t\t\t\t\t\tc4.652,3.563,3.417,12.679,4.695,13.691C50.975,160.426,54.926,154.379,54.614,153.206z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x35__24_\" class=\"B5 B6\" d=\"M31.903,157.147\r\n\t\t\t\t\t\t\tc-1.564-1.875-2.329-4.396-2.433-6.81c-0.051-1.215,0.123-2.742,0.667-3.848c0.805-1.635,2.326-3.038,3.899-3.921\r\n\t\t\t\t\t\t\tc0.847-0.476,1.835-0.876,2.792-1.068c3.35-0.675,5.962,0.88,7.892,2.931c1.065,1.132,5.753,6.261,4.98,13.568\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__24_\" class=\"B4\" d=\"M49.462,157.141c-0.231-0.47-0.285-1.247-0.422-1.821\r\n\t\t\t\t\t\t\tc-0.14-0.59-0.343-1.129-0.501-1.709c-0.921-3.372-2.326-5.564-4.896-7.829c-0.765-0.673-2.299-1.786-3.581-2.278\r\n\t\t\t\t\t\t\tc-1.598-0.612-3.473-0.534-5.004,0.17c-2.916,1.341-4.373,5.137-4.162,8.184c0.055,0.795,0.26,1.697,0.611,2.418\r\n\t\t\t\t\t\t\tc0.361,0.737,0.549,1.724,1.139,2.298c0.494,0.479,1.122,0.967,1.789,1.533\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__24_\" class=\"B2\" d=\"M48.76,159.132c0.175-0.385,0.146-0.928,0.175-1.342\r\n\t\t\t\t\t\t\tc0.114-1.622,0.062-3.411-0.544-4.943c-0.5-1.265-1.516-2.23-2.521-3.104c-1.243-1.08-3.028-2.711-4.732-2.652\r\n\t\t\t\t\t\t\tc-0.795,0.026-1.784,0.427-2.4,1.023c-1.381,1.34-1.907,3.308-1.11,5.004c0.204,0.436,0.479,0.873,0.784,1.245\r\n\t\t\t\t\t\t\tc0.326,0.399,0.68,0.79,1.054,1.145c0.974,0.926,1.995,1.865,2.507,3.133c0.208,0.51,0.395,1.057,0.541,1.584\r\n\t\t\t\t\t\t\tc0.124,0.446,0.214,1.002,0.07,1.454\"></path>\r\n\t\t\t\t\t\t<path id=\"_x35__23_\" class=\"B5 B6\" d=\"M43.828,172.511\r\n\t\t\t\t\t\t\tc0.021-0.08,0.147-0.589,0.033-0.156c-1.171,4.746-6.237,7.623-10.923,6.424c-4.641-1.188-8.021-5.627-7.963-10.537\r\n\t\t\t\t\t\t\tc0.03-2.511,0.464-5.109,1.366-7.334c0.858-2.118,3.275-3.659,4.763-5.341c4.621-5.225,9.766-2.105,15.704-2.158\r\n\t\t\t\t\t\t\tc5.382-0.048,10.005,3.907,12.891,8.091c5.354,7.763,6.063,22.329-0.237,29.804c-6.995,8.299-18.861,11.573-29.319,9.401\r\n\t\t\t\t\t\t\tc-2.064-0.429-4.144-1.076-5.892-2.288c-1.734-1.203-2.818-3.196-4.656-4.237c-1.58-0.895-3.548-0.765-5.16-1.618\r\n\t\t\t\t\t\t\tc-1.594-0.844-2.972-2.158-4.153-3.492c-8.607-9.717-6.893-22.191-6.306-34.16c0.132-2.69,0.697-5.081,0.666-7.668\r\n\t\t\t\t\t\t\tc-0.034-2.838,0.296-5.687,0.933-8.453c0.39-1.692,0.558-5.072,2.259-5.94c-0.466,0.237-0.336,6.052-0.366,6.641\r\n\t\t\t\t\t\t\tc-0.206,4.017-0.532,8.08,0.053,12.08c1.561,10.669,10.932,20.248,19.91,25.554c1.069,0.632,2.232,0.91,3.379,1.494\r\n\t\t\t\t\t\t\tC36.448,181.489,42.316,178.266,43.828,172.511z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__23_\" class=\"B4\" d=\"M42.627,173.724c-5.569,3.115-18.266-1.076-13.819-11.465\r\n\t\t\t\t\t\t\tc2-4.673,14.375-8.807,21.625-4.673c8.332,4.75,12.282,15.736,10.5,23.655c-1.125,5-7.377,12.109-10.125,13.613\r\n\t\t\t\t\t\t\tc-13.5,7.387-24.859,0.889-29.75-1.988c-6.452-3.796-12.125-10-14.402-17.167c-1.048-3.299-0.348-17.609,0.902-20.085\r\n\t\t\t\t\t\t\tc0.875,4.306,11.943,16.237,13.561,17.646c1.755,1.528,4.015,2.771,6.051,3.754c2.417,1.168,5.153,1.637,7.787,1.871\r\n\t\t\t\t\t\t\tC38.346,179.188,42.129,176.672,42.627,173.724z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__23_\" class=\"B2\" d=\"M42.627,173.724c-3.817,0.979-10.906-3.251-8.919-8.325\r\n\t\t\t\t\t\t\tc2.115-5.397,9.541-3.924,13.401-2.107c5.856,2.755,7.556,8.632,6.42,14.754c-0.645,3.475-2.459,7.307-5.029,9.803\r\n\t\t\t\t\t\t\tc-8.971,8.713-22.902,0.52-25.152-1.569c-3.541-3.287-6.31-9.388-7.49-12.415c-0.601-1.539-0.825-4.817-0.825-7.107\r\n\t\t\t\t\t\t\tc2.015,2.621,3.525,4.179,5.143,5.588c1.755,1.528,11.561,6.308,14.194,6.542C37.76,179.188,40.9,177.67,42.627,173.724z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"A_5_\">\r\n\t\t\t\t\t\t<path class=\"A5 A6\" d=\"M97.808,133.239c0.583-4.497-0.833-13.803-4.25-17.217\r\n\t\t\t\t\t\t\tc-3.775-3.772-9.654-8.961-14.888-10.577c-6.476-2-13.525-3.791-19.946-4.873C50.88,99.25,43.445,98.383,35.646,99\r\n\t\t\t\t\t\t\tc-4.831,0.382-9.547,2.33-13.438,5.184c-5.257,3.857-9.228,10.839-8.508,17.365c0.747,6.779,7.736,10.189,14.209,8.727\r\n\t\t\t\t\t\t\tc4.022-0.908,7.05-3.888,7.174-8.055c0.156-5.289-2.865-5.727-6.619-8.229c-0.238-0.159,2.094-3.913,4.24-4.335\r\n\t\t\t\t\t\t\tc2.303-0.453,7.021-0.973,9.354-1c6.92-0.081,13.599,0.953,20.496,1.83c5.486,0.697,10.328,1.719,15.504,3.506\r\n\t\t\t\t\t\t\tc5.305,1.831,9.25,5.747,13.583,10.58C93.153,126.258,96.391,130.072,97.808,133.239z\"></path>\r\n\t\t\t\t\t\t<path class=\"A4\" d=\"M96.558,129.017c-0.131-1.241-1.015-9.53-1.75-10.611c-3.861-5.675-9.148-9.971-14.238-12.235\r\n\t\t\t\t\t\t\tc-2.38-1.06-5.031-1.705-7.2-2.276c-7.425-1.955-19.192-4.15-21.552-4.353c-7.083-0.609-18.124-0.744-24.009,1.753\r\n\t\t\t\t\t\t\tc-1.548,0.656-5.688,2.899-6.945,3.974c-3.197,2.736-4.694,7.137-5.367,8.724c-0.903,2.137-0.162,5.157,0.189,7.291\r\n\t\t\t\t\t\t\tc0.313,1.907,1.967,5.876,5.653,7.072c2.053,0.666,5.239,0.993,7.233,0.189c3.334-1.344,6.204-4.013,4.231-10.109\r\n\t\t\t\t\t\t\tc-1.147-3.546-5.183-4.616-8.067-2.886c-1.824,1.094-3.63,4.864-2.215,6.736c0.433,0.57,1.721,1.242,2.308,1.434\r\n\t\t\t\t\t\t\tc-1.273,0.573-2.053,0.527-3.233-0.088c-2.148-1.12-1.569-5.603-0.463-6.84c0.998-1.118,2.816-3.145,4.426-3.636\r\n\t\t\t\t\t\t\tc1.333-0.407,1.92-1.556,2.333-2.167c0.492-0.729,3.027-2.57,4.167-2.997c3.179-1.193,6.606-1.229,9.956-1.206\r\n\t\t\t\t\t\t\tc2.675,0.019,5.354-0.095,8.026,0.06c2.595,0.149,9.466,0.752,12.393,1.146c2.065,0.278,8.207,1.752,10.266,2.073\r\n\t\t\t\t\t\t\tc1.52,0.236,6.507,2.061,7.871,2.802c5.238,2.848,7.043,4.497,10.788,9.263c1.224,1.558,2.42,3.137,3.634,4.702\r\n\t\t\t\t\t\t\tC95.516,127.508,96.193,128.231,96.558,129.017z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t</g>\r\n\t\t\t</g>\r\n\t\t\t<g id=\"Up\">\r\n\t\t\t\t<g id=\"R\">\r\n\t\t\t\t\t<g id=\"C\">\r\n\t\t\t\t\t\t<path id=\"_x35__3_\" class=\"C5 C6\" d=\"M231.893,84.178\r\n\t\t\t\t\t\t\tc-11.414-12.396-26.592-27.329-44.062-24.436c-19.625,3.25-31.354,16.905-31.375,38c-0.018,19,10.673,28.061,16.375,31.5\r\n\t\t\t\t\t\t\tc0-0.001,7.329-8.015,9.249-10.498c4.842-6.265,10.975-11.666,18.015-15.336c7.745-4.038,16.34-5.438,24.728-7.532\r\n\t\t\t\t\t\t\tc4.367-1.09,8.464-3.157,12.643-4.797C237.918,90.901,234.773,87.306,231.893,84.178z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__3_\" class=\"C4\" d=\"M218.457,82.742c-8.82-6.627-21.727-15.356-33.418-13.421\r\n\t\t\t\t\t\t\tc-8.417,1.394-16.894,7.779-20.335,15.5c-4.103,9.204-1.258,20.109,3.003,29.671c1.178,2.643,2.5,5.25,5.02,6.688\r\n\t\t\t\t\t\t\tc1.941-3.859,1.664-5.489,4.316-8.92c2.905-3.759,10.94-10.317,15.164-12.519c4.647-2.423,10.218-4.112,15.25-5.368\r\n\t\t\t\t\t\t\tc2.62-0.654,19.25-4.273,19.25-4.273S223.292,86.375,218.457,82.742z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__3_\" class=\"C2\" d=\"M211.854,81.861c-2.981-2.122-6.591-3.869-7.551-4.262\r\n\t\t\t\t\t\t\tc-6.143-2.516-13.028-3.445-19.598-2.357c-12.316,2.039-20.137,15.803-18.118,27.624c0.411,2.404,4.369,11.626,4.369,11.626\r\n\t\t\t\t\t\t\ts4.48-7.24,7-11c2.405-3.588,6.706-6.082,10.317-8.355c4.547-2.862,9.858-3.822,15.1-4.51\r\n\t\t\t\t\t\t\tc3.164-0.416,16.583-1.909,16.583-1.909S215.234,84.268,211.854,81.861z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__2_\" class=\"C1\" d=\"M207.579,83.229c-1.873-0.92-3.976-1.627-5.771-2.123\r\n\t\t\t\t\t\t\tc-4.537-1.252-9.397-1.196-13.971-0.146c-6.302,1.446-13.16,5.23-15.447,11.465c-3.479,9.488-2.933,11.566-1.183,16.066\r\n\t\t\t\t\t\t\tc3.443-8.145,7.042-14.925,14.75-19.774c7.751-4.877,18.969-1.618,27.5-1.226c-1.38-0.063-2.274-1.933-3.25-2.678\r\n\t\t\t\t\t\t\tC209.439,84.229,208.54,83.701,207.579,83.229z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"B\">\r\n\t\t\t\t\t\t<path id=\"_x35__2_\" class=\"B5 B6\" d=\"M258.786,93.958\r\n\t\t\t\t\t\t\tc-0.435-3.861-1.491-7.57-2.606-10.672c-4.811-13.384-15.281-23.262-20.906-26.887c-2.973-1.916-10.42-5.979-15.875-7.563\r\n\t\t\t\t\t\t\tc-4.647-1.349-11.509-1.992-12.692-1.992c-1.708,0-16.437,0.79-21.843,3.038c6.727,4.191,13.624,6.995,19.277,12.841\r\n\t\t\t\t\t\t\tc4.537,4.692,8.313,10.215,12.036,15.563c3.532,5.074,7.304,11.187,6.456,17.649c-0.207,1.573-0.634,3.108-1.024,4.647\r\n\t\t\t\t\t\t\tc-0.487,1.922-0.914,3.851-0.762,5.866c0.174,2.31,1.541,5.352,2.935,7.174c6.333,8.278,20.637,5.797,27.826,0.119\r\n\t\t\t\t\t\t\tC258.312,108.448,259.573,100.953,258.786,93.958z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__1_\" class=\"B4\" d=\"M222.598,106.791c2.75,4.75,6.984,8.113,11.353,9.31\r\n\t\t\t\t\t\t\tc2.522,0.69,6.857-0.44,10.435-1.794c4.338-1.641,10.137-7.524,12.259-13.107c1.865-4.908,0.167-13.887-0.948-16.988\r\n\t\t\t\t\t\t\tc-4.811-13.385-15.281-23.262-20.906-26.887c-2.973-1.916-10.42-5.979-15.875-7.563c-4.647-1.349-11.509-1.992-12.692-1.992\r\n\t\t\t\t\t\t\tc-1.708,0-16.437,0.791-21.843,3.039c6.727,4.19,13.624,6.994,19.277,12.84c4.537,4.692,8.313,10.216,12.036,15.563\r\n\t\t\t\t\t\t\tc3.532,5.074,7.304,11.187,6.456,17.649c-0.207,1.573-0.634,3.108-1.024,4.647C221.279,101.79,221.213,104.399,222.598,106.791\r\n\t\t\t\t\t\t\tz\"></path>\r\n\t\t\t\t\t\t<path id=\"_x33_\" class=\"B3\" d=\"M223.126,91.46c1.037,4.149,1.234,6.152,2.425,8.908\r\n\t\t\t\t\t\t\tc2.368,5.478,6.36,10.777,12.944,10.669c8.787-0.145,13.46-9.74,14.204-17.381c0.915-9.395-1.198-19.328-7.35-26.684\r\n\t\t\t\t\t\t\tc-6.742-8.062-16.476-14.265-26.615-16.992c-5.329-1.433-11.744-2.52-17.281-2.132c-5.961,0.417-11.799,1.517-17.59,2.959\r\n\t\t\t\t\t\t\tc16.846,6.486,25.069,16.707,33.513,29.653C219.762,84.119,222.127,87.464,223.126,91.46z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__1_\" class=\"B2\" d=\"M228.107,93.742c2.813,6.342,7.848,18.236,14.699,7.287\r\n\t\t\t\t\t\t\tc2.664-4.256,3.43-9.494,4.083-14.377c1.11-8.288-2.774-17.112-6.615-24.771c-6.16-5.52-13.753-9.714-21.595-11.823\r\n\t\t\t\t\t\t\tc-5.329-1.433-11.744-2.52-17.281-2.132c-5.961,0.417-11.799,1.517-17.59,2.959c10.44,5.29,21.667,11.052,28.993,19.655\r\n\t\t\t\t\t\t\tC218.875,77.673,223.926,84.32,228.107,93.742z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__1_\" class=\"B1\" d=\"M237.29,67.992c2.574,3.701,4.463,6.896,5.833,11.195\r\n\t\t\t\t\t\t\tc1.309,4.106,1.239,11.204-0.75,15.222c-1.025,2.07-3.378,4.017-5.432,2.082c-1.604-1.512-0.667-5.472-0.569-7.416\r\n\t\t\t\t\t\t\tc0.585-11.705-9.269-31.012-9.416-31.226C226.957,57.849,235.903,65.998,237.29,67.992z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x35__1_\" class=\"B5 B6\" d=\"M204.561,86.093\r\n\t\t\t\t\t\t\tc0.833,4.813,3.689,9.24,7.238,12.521c1.785,1.65,4.339,3.36,6.73,3.962c3.533,0.89,7.641,0.384,11.024-0.872\r\n\t\t\t\t\t\t\tc1.822-0.676,3.711-1.666,5.241-2.875c5.364-4.236,6.373-10.232,5.743-15.828c-0.348-3.089-2.103-16.876-14.247-25.152\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__2_\" class=\"B4\" d=\"M227.29,59.325c0.417,0.961,1.532,2.049,2.231,3\r\n\t\t\t\t\t\t\tc0.717,0.976,1.278,1.984,1.958,2.977c3.95,5.767,5.476,10.748,5.602,17.598c0.038,2.036-0.25,5.817-1.159,8.407\r\n\t\t\t\t\t\t\tc-1.133,3.229-3.678,5.987-6.734,7.411c-5.818,2.711-13.491,0.021-17.864-4.24c-1.144-1.114-2.253-2.594-2.896-4.063\r\n\t\t\t\t\t\t\tc-0.658-1.505-1.919-3.065-2.031-4.712c-0.093-1.369-0.023-2.961-0.023-4.711\"></path>\r\n\t\t\t\t\t\t<path id=\"_x33__1_\" class=\"B3\" d=\"M209.123,82.117c1.705,3.551,4.926,8.746,8.532,10.559\r\n\t\t\t\t\t\t\tc7.197,3.618,14.379-1.772,16.367-8.807c2.506-8.871-1.671-18.554-8.024-24.752\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__2_\" class=\"B2\" d=\"M218.54,51.117c0.813,0.23,1.603,0.978,2.272,1.47\r\n\t\t\t\t\t\t\tc2.621,1.926,5.281,4.321,6.834,7.226c1.283,2.399,1.44,5.198,1.472,7.862c0.039,3.292,0.216,8.128-2.079,10.651\r\n\t\t\t\t\t\t\tc-1.07,1.177-2.958,2.167-4.667,2.333c-3.829,0.374-7.51-1.371-9.068-4.781c-0.4-0.875-0.71-1.861-0.885-2.808\r\n\t\t\t\t\t\t\tc-0.187-1.013-0.323-2.059-0.381-3.088c-0.152-2.682-0.263-5.454-1.532-7.877c-0.511-0.976-1.1-1.967-1.716-2.875\r\n\t\t\t\t\t\t\tc-0.521-0.766-1.252-1.623-2.126-1.989\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"A\">\r\n\t\t\t\t\t\t<path id=\"_x35_\" class=\"A5 A6\" d=\"M159.832,78.617c0-2.5,0.434-5.175,1.916-7.782\r\n\t\t\t\t\t\t\tc1.635-2.877,3.535-5.608,5.291-8.364c2.32-3.643,5.255-6.894,8.75-9.452c1.986-1.454,4.252-2.603,6.577-3.413\r\n\t\t\t\t\t\t\tc8.746-3.047,19.146-1.937,26.615,3.706c6.68,5.046,11.725,14.179,10.811,22.716c-0.949,8.868-9.829,13.329-18.055,11.415\r\n\t\t\t\t\t\t\tc-3.53-0.821-7.278-2.725-8.465-6.403c-1.298-4.02-0.985-7.254,0.938-10.735c0.584-1.058,2.875-3.42,4.582-4.591\r\n\t\t\t\t\t\t\tc-4.395-3.909-13.127-3.458-16.02-2.847c-4.588,0.971-7.92,3.829-11.563,6.706c-1.819,1.437-3.7,2.783-5.534,4.201\r\n\t\t\t\t\t\t\tC163.88,75.158,159.832,78.617,159.832,78.617z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34_\" class=\"A4\" d=\"M161.832,75.367c0.167-1.623,1.358-3.62,2.142-5.126\r\n\t\t\t\t\t\t\tc1.352-2.599,3.058-4.898,4.434-7.512c4.236-8.049,14.863-12.784,17.861-13.049c9-0.796,14.036,1.813,17.563,3.484\r\n\t\t\t\t\t\t\tc1.941,0.92,3.841,2.094,5.438,3.5c4.063,3.578,6.322,8.145,7.176,10.22c1.149,2.795,1.27,6.004,0.824,8.795\r\n\t\t\t\t\t\t\tc-0.398,2.494-2.5,7.688-7.184,9.252c-2.609,0.871-6.656,1.3-9.191,0.248c-4.235-1.757-7.881-5.25-5.375-13.225\r\n\t\t\t\t\t\t\tc1.458-4.639,6.583-6.04,10.25-3.775c2.317,1.432,4.612,6.364,2.813,8.813c-0.548,0.746-2.185,1.625-2.93,1.875\r\n\t\t\t\t\t\t\tc1.617,0.75,2.607,0.69,4.107-0.115c2.73-1.465,1.994-7.329,0.589-8.948c-1.269-1.462-4.347-3.295-6.391-3.938\r\n\t\t\t\t\t\t\tc-1.694-0.533-3.295-0.625-3.82-1.424c-0.626-0.953-1.917-2.017-3.364-2.576c-1.7-0.656-3.269-1.47-5.066-1.753\r\n\t\t\t\t\t\t\tc-2.067-0.326-4.076-0.292-6.188-0.184c-2.609,0.133-5.445,0.666-7.874,1.688c-3.216,1.353-5.937,3.666-8.707,5.75\r\n\t\t\t\t\t\t\tc-1.519,1.144-2.951,2.408-4.232,3.811c-0.566,0.62-1.01,1.333-1.465,2.036C162.869,73.789,162.41,74.085,161.832,75.367z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32_\" class=\"A2\" d=\"M200.698,64.753c0.499,0.726,3.345,0.934,4.438,1.453\r\n\t\t\t\t\t\t\tc1.471,0.699,2.427,1.064,3.532,1.949c0.177-7.137-10.154-12.346-15.708-13.158c-3.259-0.477-8.422-0.616-11.556,0.433\r\n\t\t\t\t\t\t\tc-3.449,1.155-5.49,2.479-8.032,4.405c-2.325,1.762-4.402,4.363-6.281,6.656c-1.469,1.792-4.781,6.875-5,8.875\r\n\t\t\t\t\t\t\tc2.31-2.379,4.065-5.462,6.875-7.702c3.14-2.504,7.156-5.528,10.563-6.54c6.06-1.8,13.156-1.8,19.325,1.756L200.698,64.753z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31_\" class=\"A1\" d=\"M161.832,75.367c1.946-2.974,4.193-5.462,7.002-7.702\r\n\t\t\t\t\t\t\tc3.14-2.504,7.156-5.528,10.563-6.54c6.06-1.8,13.156-1.8,19.325,1.756l1.845,1.873c0.499,0.726,3.651,1.122,4.744,1.642\r\n\t\t\t\t\t\t\tc0.138-0.527-0.369-1.543-0.75-1.935c-1.833-1.88-3.713-3.777-6.101-4.944c-0.999-0.488-2.119-0.663-3.21-0.884\r\n\t\t\t\t\t\t\tc-2.855-0.578-5.583-0.903-8.886-0.953c-1.115-0.017-3.229,0.227-4.338,0.348c-1.393,0.151-2.866,0.497-4.161,1.043\r\n\t\t\t\t\t\t\tc-2.016,0.851-3.995,1.893-5.907,2.953c-2.537,1.406-4.247,3.854-5.788,6.236c-0.844,1.305-1.792,2.533-2.65,3.826\r\n\t\t\t\t\t\t\tc-0.36,0.542-0.45,0.925-0.809,1.469C162.496,73.879,162.105,75.085,161.832,75.367z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t</g>\r\n\t\t\t\t<g id=\"L\">\r\n\t\t\t\t\t<g id=\"C_4_\">\r\n\t\t\t\t\t\t<path id=\"_x35__30_\" class=\"C5 C6\" d=\"M65.121,84.178\r\n\t\t\t\t\t\t\tc11.414-12.396,26.592-27.329,44.062-24.436c19.625,3.25,31.354,16.905,31.375,38c0.018,19-10.673,28.061-16.375,31.5\r\n\t\t\t\t\t\t\tc0-0.001-7.329-8.015-9.249-10.498c-4.842-6.265-10.975-11.666-18.015-15.336c-7.745-4.038-16.34-5.438-24.728-7.532\r\n\t\t\t\t\t\t\tc-4.367-1.09-8.464-3.157-12.643-4.797C59.096,90.901,62.241,87.306,65.121,84.178z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__30_\" class=\"C4\" d=\"M78.558,82.742c8.82-6.627,21.727-15.356,33.418-13.421\r\n\t\t\t\t\t\t\tc8.417,1.394,16.894,7.779,20.335,15.5c4.103,9.204,1.258,20.109-3.003,29.671c-1.178,2.643-2.5,5.25-5.02,6.688\r\n\t\t\t\t\t\t\tc-1.941-3.859-1.664-5.489-4.316-8.92c-2.905-3.759-10.94-10.317-15.164-12.519c-4.647-2.423-10.218-4.112-15.25-5.368\r\n\t\t\t\t\t\t\tc-2.62-0.654-19.25-4.273-19.25-4.273S73.722,86.375,78.558,82.742z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__30_\" class=\"C2\" d=\"M85.16,81.861c2.981-2.122,6.591-3.869,7.551-4.262\r\n\t\t\t\t\t\t\tc6.143-2.516,13.028-3.445,19.598-2.357c12.316,2.039,20.137,15.803,18.118,27.624c-0.411,2.404-4.369,11.626-4.369,11.626\r\n\t\t\t\t\t\t\ts-4.48-7.24-7-11c-2.405-3.588-6.706-6.082-10.317-8.355c-4.547-2.862-9.858-3.822-15.1-4.51\r\n\t\t\t\t\t\t\tc-3.164-0.416-16.583-1.909-16.583-1.909S81.78,84.268,85.16,81.861z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__22_\" class=\"C1\" d=\"M89.435,83.229c1.873-0.92,3.976-1.627,5.771-2.123\r\n\t\t\t\t\t\t\tc4.537-1.252,9.397-1.196,13.971-0.146c6.302,1.446,13.16,5.23,15.447,11.465c3.479,9.488,2.933,11.566,1.183,16.066\r\n\t\t\t\t\t\t\tc-3.443-8.145-7.042-14.925-14.75-19.774c-7.751-4.877-18.969-1.618-27.5-1.226c1.38-0.063,2.274-1.933,3.25-2.678\r\n\t\t\t\t\t\t\tC87.575,84.229,88.475,83.701,89.435,83.229z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"B_6_\">\r\n\t\t\t\t\t\t<path id=\"_x35__29_\" class=\"B5 B6\" d=\"M38.229,93.958\r\n\t\t\t\t\t\t\tc0.435-3.861,1.491-7.57,2.606-10.672C45.646,69.902,56.116,60.025,61.741,56.4c2.973-1.916,10.42-5.979,15.875-7.563\r\n\t\t\t\t\t\t\tc4.647-1.349,11.509-1.992,12.692-1.992c1.708,0,16.437,0.79,21.843,3.038c-6.727,4.191-13.624,6.995-19.277,12.841\r\n\t\t\t\t\t\t\tc-4.537,4.692-8.313,10.215-12.036,15.563c-3.532,5.074-7.304,11.187-6.456,17.649c0.207,1.573,0.634,3.108,1.024,4.647\r\n\t\t\t\t\t\t\tc0.487,1.922,0.914,3.851,0.762,5.866c-0.174,2.31-1.541,5.352-2.935,7.174c-6.333,8.278-20.637,5.797-27.826,0.119\r\n\t\t\t\t\t\t\tC38.702,108.448,37.441,100.953,38.229,93.958z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__29_\" class=\"B4\" d=\"M74.416,106.791c-2.75,4.75-6.984,8.113-11.353,9.31\r\n\t\t\t\t\t\t\tc-2.522,0.69-6.857-0.44-10.435-1.794c-4.338-1.641-10.137-7.524-12.259-13.107c-1.865-4.908-0.167-13.887,0.948-16.988\r\n\t\t\t\t\t\t\tc4.811-13.385,15.281-23.262,20.906-26.887c2.973-1.916,10.42-5.979,15.875-7.563c4.647-1.349,11.509-1.992,12.692-1.992\r\n\t\t\t\t\t\t\tc1.708,0,16.437,0.791,21.843,3.039c-6.727,4.19-13.624,6.994-19.277,12.84c-4.537,4.692-8.313,10.216-12.036,15.563\r\n\t\t\t\t\t\t\tc-3.532,5.074-7.304,11.187-6.456,17.649c0.207,1.573,0.634,3.108,1.024,4.647C75.735,101.79,75.801,104.399,74.416,106.791z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x33__5_\" class=\"B3\" d=\"M73.888,91.46c-1.037,4.149-1.234,6.152-2.425,8.908\r\n\t\t\t\t\t\t\tc-2.368,5.478-6.36,10.777-12.944,10.669c-8.787-0.145-13.46-9.74-14.204-17.381c-0.915-9.395,1.198-19.328,7.35-26.684\r\n\t\t\t\t\t\t\tc6.742-8.062,16.476-14.265,26.615-16.992c5.329-1.433,11.744-2.52,17.281-2.132c5.961,0.417,11.799,1.517,17.59,2.959\r\n\t\t\t\t\t\t\tc-16.846,6.486-25.069,16.707-33.513,29.653C77.252,84.119,74.887,87.464,73.888,91.46z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__29_\" class=\"B2\" d=\"M68.907,93.742c-2.813,6.342-7.848,18.236-14.699,7.287\r\n\t\t\t\t\t\t\tc-2.664-4.256-3.43-9.494-4.083-14.377c-1.11-8.288,2.774-17.112,6.615-24.771c6.16-5.52,13.753-9.714,21.595-11.823\r\n\t\t\t\t\t\t\tc5.329-1.433,11.744-2.52,17.281-2.132c5.961,0.417,11.799,1.517,17.59,2.959c-10.44,5.29-21.667,11.052-28.993,19.655\r\n\t\t\t\t\t\t\tC78.139,77.673,73.088,84.32,68.907,93.742z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__21_\" class=\"B1\" d=\"M59.724,67.992c-2.574,3.701-4.463,6.896-5.833,11.195\r\n\t\t\t\t\t\t\tc-1.309,4.106-1.239,11.204,0.75,15.222c1.025,2.07,3.378,4.017,5.432,2.082c1.604-1.512,0.667-5.472,0.569-7.416\r\n\t\t\t\t\t\t\tc-0.585-11.705,9.269-31.012,9.416-31.226C70.058,57.849,61.111,65.998,59.724,67.992z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x35__28_\" class=\"B5 B6\" d=\"M92.454,86.093\r\n\t\t\t\t\t\t\tc-0.833,4.813-3.689,9.24-7.238,12.521c-1.785,1.65-4.339,3.36-6.73,3.962c-3.533,0.89-7.641,0.384-11.024-0.872\r\n\t\t\t\t\t\t\tc-1.822-0.676-3.711-1.666-5.241-2.875c-5.364-4.236-6.373-10.232-5.743-15.828c0.348-3.089,2.103-16.876,14.247-25.152\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__28_\" class=\"B4\" d=\"M69.724,59.325c-0.417,0.961-1.532,2.049-2.231,3\r\n\t\t\t\t\t\t\tc-0.717,0.976-1.278,1.984-1.958,2.977c-3.95,5.767-5.476,10.748-5.602,17.598c-0.038,2.036,0.25,5.817,1.159,8.407\r\n\t\t\t\t\t\t\tc1.133,3.229,3.678,5.987,6.734,7.411c5.818,2.711,13.491,0.021,17.864-4.24c1.144-1.114,2.253-2.594,2.896-4.063\r\n\t\t\t\t\t\t\tc0.658-1.505,1.919-3.065,2.031-4.712c0.093-1.369,0.023-2.961,0.023-4.711\"></path>\r\n\t\t\t\t\t\t<path id=\"_x33__4_\" class=\"B3\" d=\"M87.891,82.117c-1.705,3.551-4.926,8.746-8.532,10.559\r\n\t\t\t\t\t\t\tc-7.197,3.618-14.379-1.772-16.367-8.807c-2.506-8.871,1.671-18.554,8.024-24.752\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__28_\" class=\"B2\" d=\"M78.474,51.117c-0.813,0.23-1.603,0.978-2.272,1.47\r\n\t\t\t\t\t\t\tc-2.621,1.926-5.281,4.321-6.834,7.226c-1.283,2.399-1.44,5.198-1.472,7.862c-0.039,3.292-0.216,8.128,2.079,10.651\r\n\t\t\t\t\t\t\tc1.07,1.177,2.958,2.167,4.667,2.333c3.829,0.374,7.51-1.371,9.068-4.781c0.4-0.875,0.71-1.861,0.885-2.808\r\n\t\t\t\t\t\t\tc0.187-1.013,0.323-2.059,0.381-3.088c0.152-2.682,0.263-5.454,1.532-7.877c0.511-0.976,1.1-1.967,1.716-2.875\r\n\t\t\t\t\t\t\tc0.521-0.766,1.252-1.623,2.126-1.989\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g id=\"A_6_\">\r\n\t\t\t\t\t\t<path id=\"_x35__27_\" class=\"A5 A6\" d=\"M137.183,78.617\r\n\t\t\t\t\t\t\tc0-2.5-0.434-5.175-1.916-7.782c-1.635-2.877-3.535-5.608-5.291-8.364c-2.32-3.643-5.255-6.894-8.75-9.452\r\n\t\t\t\t\t\t\tc-1.986-1.454-4.252-2.603-6.577-3.413c-8.746-3.047-19.146-1.937-26.615,3.706c-6.68,5.046-11.725,14.179-10.811,22.716\r\n\t\t\t\t\t\t\tc0.949,8.868,9.829,13.329,18.055,11.415c3.53-0.821,7.278-2.725,8.465-6.403c1.298-4.02,0.985-7.254-0.938-10.735\r\n\t\t\t\t\t\t\tc-0.584-1.058-2.875-3.42-4.582-4.591c4.395-3.909,13.127-3.458,16.02-2.847c4.588,0.971,7.92,3.829,11.563,6.706\r\n\t\t\t\t\t\t\tc1.819,1.437,3.7,2.783,5.534,4.201C133.134,75.158,137.183,78.617,137.183,78.617z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x34__27_\" class=\"A4\" d=\"M135.183,75.367c-0.167-1.623-1.358-3.62-2.142-5.126\r\n\t\t\t\t\t\t\tc-1.352-2.599-3.058-4.898-4.434-7.512c-4.236-8.049-14.863-12.784-17.861-13.049c-9-0.796-14.036,1.813-17.563,3.484\r\n\t\t\t\t\t\t\tc-1.941,0.92-3.841,2.094-5.438,3.5c-4.063,3.578-6.322,8.145-7.176,10.22c-1.149,2.795-1.27,6.004-0.824,8.795\r\n\t\t\t\t\t\t\tc0.398,2.494,2.5,7.688,7.184,9.252c2.609,0.871,6.656,1.3,9.191,0.248c4.235-1.757,7.881-5.25,5.375-13.225\r\n\t\t\t\t\t\t\tc-1.458-4.639-6.583-6.04-10.25-3.775c-2.317,1.432-4.612,6.364-2.813,8.813c0.548,0.746,2.185,1.625,2.93,1.875\r\n\t\t\t\t\t\t\tc-1.617,0.75-2.607,0.69-4.107-0.115c-2.73-1.465-1.994-7.329-0.589-8.948c1.269-1.462,4.347-3.295,6.391-3.938\r\n\t\t\t\t\t\t\tc1.694-0.533,3.295-0.625,3.82-1.424c0.626-0.953,1.917-2.017,3.364-2.576c1.7-0.656,3.269-1.47,5.066-1.753\r\n\t\t\t\t\t\t\tc2.067-0.326,4.076-0.292,6.188-0.184c2.609,0.133,5.445,0.666,7.874,1.688c3.216,1.353,5.937,3.666,8.707,5.75\r\n\t\t\t\t\t\t\tc1.519,1.144,2.951,2.408,4.232,3.811c0.566,0.62,1.01,1.333,1.465,2.036C134.145,73.789,134.604,74.085,135.183,75.367z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x32__27_\" class=\"A2\" d=\"M96.316,64.753c-0.499,0.726-3.345,0.934-4.438,1.453\r\n\t\t\t\t\t\t\tc-1.471,0.699-2.427,1.064-3.532,1.949c-0.177-7.137,10.154-12.346,15.708-13.158c3.259-0.477,8.422-0.616,11.556,0.433\r\n\t\t\t\t\t\t\tc3.449,1.155,5.49,2.479,8.032,4.405c2.325,1.762,4.402,4.363,6.281,6.656c1.469,1.792,4.781,6.875,5,8.875\r\n\t\t\t\t\t\t\tc-2.31-2.379-4.065-5.462-6.875-7.702c-3.14-2.504-7.156-5.528-10.563-6.54c-6.06-1.8-13.156-1.8-19.325,1.756L96.316,64.753z\"></path>\r\n\t\t\t\t\t\t<path id=\"_x31__20_\" class=\"A1\" d=\"M135.183,75.367c-1.946-2.974-4.193-5.462-7.002-7.702\r\n\t\t\t\t\t\t\tc-3.14-2.504-7.156-5.528-10.563-6.54c-6.06-1.8-13.156-1.8-19.325,1.756l-1.845,1.873c-0.499,0.726-3.651,1.122-4.744,1.642\r\n\t\t\t\t\t\t\tc-0.138-0.527,0.369-1.543,0.75-1.935c1.833-1.88,3.713-3.777,6.101-4.944c0.999-0.488,2.119-0.663,3.21-0.884\r\n\t\t\t\t\t\t\tc2.855-0.578,5.583-0.903,8.886-0.953c1.115-0.017,3.229,0.227,4.338,0.348c1.393,0.151,2.866,0.497,4.161,1.043\r\n\t\t\t\t\t\t\tc2.016,0.851,3.995,1.893,5.907,2.953c2.537,1.406,4.247,3.854,5.788,6.236c0.844,1.305,1.792,2.533,2.65,3.826\r\n\t\t\t\t\t\t\tc0.36,0.542,0.45,0.925,0.809,1.469C134.518,73.879,134.909,75.085,135.183,75.367z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t</g>\r\n\t\t\t</g>\r\n\t\t</g>\r\n\t\t<g id=\"花瓣3\">\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M94.054,114.337c-1.521-4.387,7.023-12.251,11.251-13.344\r\n\t\t\t\t\tc4.228-1.092,10.286-1.566,12.137,6.211c1.606,6.753-2.815,11.327-7.043,12.418C106.171,120.718,96.336,120.92,94.054,114.337z\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M96.408,113.529c-1.217-3.509,5.619-9.801,9.001-10.675c3.382-0.873,8.229-1.253,9.709,4.969\r\n\t\t\t\t\tc1.285,5.402-2.252,9.062-5.635,9.935C106.102,118.634,98.234,118.795,96.408,113.529z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M84.702,125.668c-1.596-4.36,7.232-12.306,11.553-13.421\r\n\t\t\t\t\tc4.32-1.117,11.681-1.817,13.528,5.961c1.604,6.754-5.69,10.762-10.011,11.877C95.452,131.204,86.989,131.917,84.702,125.668z\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M87.214,124.775c-1.277-3.488,5.786-9.845,9.242-10.737c3.456-0.894,9.345-1.454,10.822,4.769\r\n\t\t\t\t\tc1.283,5.403-4.552,8.609-8.009,9.502C95.813,129.203,89.043,129.774,87.214,124.775z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M96.308,124.179c6.307,4.236,6,12,0.657,18.758\r\n\t\t\t\t\tc-3.083,3.9-7.157,7.408-14.49,2.574c-5.795-3.82-1.825-13.138,1.5-16.832C87.127,125.175,91.475,120.932,96.308,124.179z\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M95.1,126.431c5.046,3.39,4.8,9.601,0.525,15.007c-2.466,3.12-5.726,5.927-11.592,2.06\r\n\t\t\t\t\tc-4.636-3.057-1.459-10.511,1.2-13.466C87.755,127.228,91.233,123.833,95.1,126.431z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M104.199,167.759c-4.772,1.523-15.98-7.646-17.492-12.383\r\n\t\t\t\t\tc-1.513-4.734-1.304-13.545,6.958-15.998c7.173-2.131,14.913,4.697,16.31,9.467C111.586,154.349,108.972,166.234,104.199,167.759\r\n\t\t\t\t\tz\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M103.002,164.898c-3.818,1.219-12.784-6.117-13.993-9.906c-1.21-3.787-1.043-10.836,5.566-12.799\r\n\t\t\t\t\tc5.738-1.704,11.93,3.758,13.048,7.574C108.912,154.169,106.82,163.677,103.002,164.898z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M125.625,172.422c-2.91,4.985-16.023,5.179-20.316,2.673\r\n\t\t\t\t\tc-4.293-2.506-9.515-7.072-4.359-15.558c4.477-7.369,12.447-5.827,16.74-3.321C121.983,158.722,128.535,167.436,125.625,172.422z\r\n\t\t\t\t\t\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M123.015,171.019c-2.328,3.988-12.818,4.144-16.253,2.139s-7.612-5.658-3.487-12.446\r\n\t\t\t\t\tc3.582-5.896,9.958-4.661,13.392-2.657C120.102,160.059,125.343,167.031,123.015,171.019z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M139.642,176.451c-2.342,4.014-12.325,4.09-16.619,1.584\r\n\t\t\t\t\tc-4.293-2.504-9.837-6.613-4.566-12.625c4.75-5.418,7.707-4.174,12-1.668C134.75,166.246,141.985,172.437,139.642,176.451z\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M137.229,175.242c-1.874,3.211-9.86,3.272-13.295,1.268c-3.435-2.003-7.87-5.291-3.653-10.1\r\n\t\t\t\t\tc3.8-4.335,6.166-3.34,9.6-1.335C133.315,167.078,139.103,172.031,137.229,175.242z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M205.964,118.191c2.621-7.186-7.344-13.357-12.156-14.6\r\n\t\t\t\t\tc-4.813-1.244-12.672-1.16-14.502,6.622c-1.588,6.758,5.289,10.769,10.102,12.011C194.22,123.47,203.575,124.744,205.964,118.191\r\n\t\t\t\t\tz\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M203.318,117.175c2.097-5.748-5.875-10.686-9.725-11.68c-3.85-0.995-10.137-0.928-11.602,5.298\r\n\t\t\t\t\tc-1.27,5.406,4.231,8.615,8.082,9.608C193.923,121.399,201.407,122.417,203.318,117.175z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M212.854,129.357c1.759-5.404-8.344-12.592-13.156-13.836\r\n\t\t\t\t\tc-4.813-1.243-11.672-1.925-13.502,5.857c-1.588,6.758,5.289,10.77,10.101,12.012\r\n\t\t\t\t\tC201.11,134.636,210.308,137.179,212.854,129.357z\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M210.185,128.441c1.407-4.323-6.675-10.073-10.525-11.068s-9.337-1.54-10.801,4.686\r\n\t\t\t\t\tc-1.271,5.406,4.231,8.616,8.08,9.609C200.79,132.665,208.148,134.699,210.185,128.441z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M201.163,126.587c-6.308,4.236-6,12-0.657,18.758\r\n\t\t\t\t\tc3.083,3.9,7.157,7.408,14.49,2.574c5.795-3.82,1.825-13.137-1.5-16.832C210.343,127.583,205.996,123.341,201.163,126.587z\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M202.371,128.839c-5.046,3.39-4.8,9.601-0.526,15.007c2.466,3.12,5.726,5.927,11.592,2.06\r\n\t\t\t\t\tc4.636-3.057,1.46-10.51-1.2-13.466C209.715,129.636,206.237,126.243,202.371,128.839z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M192.497,169.919c4.427,1.414,15.091-7.93,16.603-12.666\r\n\t\t\t\t\tc1.513-4.734,1.503-13.48-6.165-15.746c-6.658-1.965-14.032,4.979-15.438,9.746C185.875,156.753,188.069,168.505,192.497,169.919\r\n\t\t\t\t\tz\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M193.682,167.058c3.542,1.132,12.073-6.344,13.282-10.133c1.21-3.787,1.203-10.784-4.932-12.597\r\n\t\t\t\t\tc-5.327-1.571-11.226,3.983-12.35,7.797C188.384,156.526,190.14,165.927,193.682,167.058z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M173.079,174.943c2.343,4.014,14.791,3.066,19.084,0.561\r\n\t\t\t\t\ts9.644-6.852,5.463-13.666c-3.63-5.918-11.337-3.924-15.63-1.418C177.702,162.925,170.736,170.927,173.079,174.943z\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M175.638,173.518c1.875,3.211,11.833,2.453,15.267,0.448c3.435-2.005,7.715-5.481,4.371-10.933\r\n\t\t\t\t\tc-2.904-4.734-9.07-3.14-12.504-1.135C179.336,163.904,173.764,170.305,175.638,173.518z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M157.829,177.859c2.343,4.014,14.791,3.066,19.084,0.561\r\n\t\t\t\t\tc4.293-2.504,9.644-6.852,5.463-13.666c-3.63-5.916-11.337-3.922-15.63-1.416C162.452,165.841,155.486,173.845,157.829,177.859z\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M160.388,176.434c1.875,3.211,11.833,2.453,15.267,0.448c3.435-2.003,7.715-5.481,4.371-10.933\r\n\t\t\t\t\tc-2.904-4.732-9.07-3.138-12.504-1.133C164.086,166.82,158.514,173.223,160.388,176.434z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"A5 A6\" d=\"M149.337,167.949c4.75,0.125,9.459,3.035,10.328,4.063\r\n\t\t\t\t\tc5.625,6.652-1.705,13.41-4.453,14.188c-2.329,0.66-6.047,3.063-6.047,3.063s-4.5-2.832-7.25-3.063\r\n\t\t\t\t\tc-2.847-0.236-11.314-6.826-4.996-14.268c1.913-2.252,6.121-3.857,10.871-3.982H149.337z\"></path>\r\n\t\t\t\t<path class=\"ring3\" d=\"M149.106,170.08c3.8,0.101,7.567,2.429,8.263,3.25c4.5,5.322-1.364,10.729-3.563,11.351\r\n\t\t\t\t\tc-1.863,0.528-4.837,2.45-4.837,2.45s-3.6-2.266-5.8-2.45c-2.277-0.189-9.051-5.461-3.997-11.414\r\n\t\t\t\t\tc1.53-1.802,4.896-3.086,8.697-3.187H149.106z\"></path>\r\n\t\t\t</g>\r\n\t\t</g>\r\n\t\t<g id=\"花瓣2\">\r\n\t\t\t<g>\r\n\t\t\t\t<path id=\"_x35__14_\" class=\"A5 A6\" d=\"M137.181,159.248\r\n\t\t\t\t\tc4-2.884,3.484-11.198,0-14.125c-3.125-2.625-10.5-9.5-15.125-14.25c-4.116-4.228-9.25-6.625-19.125-6\r\n\t\t\t\t\tc-9.875,0.626-12.75,12.874-12.75,12.875c0,0,7.375,2.625,8.75,9c1.228,5.69,11.5,14,18.5,15.25\r\n\t\t\t\t\tC121.173,162.666,133.137,162.164,137.181,159.248z\"></path>\r\n\t\t\t\t<path id=\"_x34__14_\" class=\"ring2_2\" d=\"M94.457,137.117c1.484,0.484,3.889,2.263,4.65,2.966\r\n\t\t\t\t\tc1.525,1.409,2.588,3.254,3.756,4.906c2.309,3.268,4.243,6.618,7.969,8.472c3.521,1.751,7.055,3.159,11.003,3.159\r\n\t\t\t\t\tc7.435,0,13.019-6.381,13.278-7.723c0.296-1.536-6.313-6.908-8.006-8.314c-1.562-1.297-7.175-6.759-9.028-7.587\r\n\t\t\t\t\tc-1.808-0.809-4.1-1.772-5.997-2.254c-4.168-1.06-7.236-1.672-11.403-0.027C97.588,131.933,94.457,137.117,94.457,137.117z\"></path>\r\n\t\t\t\t<path id=\"_x32__14_\" class=\"ring2_1\" d=\"M103.306,135.248c5.125-1.125,18.75,0.375,25.5,11.5\r\n\t\t\t\t\tc1.805,2.975-11.802,2.221-12.933,1.498C111.95,145.724,105.968,140.333,103.306,135.248z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path id=\"_x35__15_\" class=\"A5 A6\" d=\"M159.681,159.498\r\n\t\t\t\t\tc-4-2.884-1.519-9.38-0.25-13.75c1.191-4.105,9.25-8.75,13.875-13.5c4.116-4.228,11.059-5.77,20.934-5.145\r\n\t\t\t\t\ts12.75,12.875,12.75,12.875s-7.375,2.625-8.75,9c-1.228,5.69-12.559,12.77-19.559,14.02\r\n\t\t\t\t\tC174.938,163.666,163.724,162.414,159.681,159.498z\"></path>\r\n\t\t\t\t<path id=\"_x34__15_\" class=\"ring2_2\" d=\"M202.747,137.112c-1.078-0.078-3.179,1.565-4.005,2.165\r\n\t\t\t\t\tc-1.382,1.001-2.255,2.928-3.318,4.313c-1.105,1.438-1.861,3.171-2.936,4.656c-1.171,1.619-2.645,2.549-4.253,3.652\r\n\t\t\t\t\tc-1.568,1.076-2.851,2.503-4.653,3.188c-1.711,0.65-3.725,0.993-5.493,1.163c-3.678,0.353-8.303-0.427-11.354-2.413\r\n\t\t\t\t\tc-2.51-1.634-6.8-4.907-4.128-8.088c2.496-2.97,6.679-3.803,9.473-6.5c3.098-2.991,5.563-6.234,9.753-7.756\r\n\t\t\t\t\tc3.728-1.354,7.575-1.461,11.597-1.652c2.422-0.116,3.887,0.406,5.747,2.177C200.644,133.414,202.747,137.112,202.747,137.112z\"></path>\r\n\t\t\t\t<path id=\"_x32__15_\" class=\"ring2_1\" d=\"M194.806,136.623c-3.184-4.98-8.375-6.125-26.605,9.875\r\n\t\t\t\t\tc-2.615,2.295,17.98-1.125,21.321-3.98C191.51,140.818,193.806,139.373,194.806,136.623z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path id=\"_x35__16_\" class=\"A5 A6\" d=\"M142.832,145.464\r\n\t\t\t\t\tc-1.751,0.707-3.475,1.506-5.122,2.309c-3.428,1.671-6.115,4.223-7.906,7.563c-1.999,3.726-2.279,7.475-0.256,11.308\r\n\t\t\t\t\tc2.204,4.178,5.574,5.3,10.034,4.848c3.701-0.376,7.638-1.94,11.122-0.871c1.88,0.577,5.816,1.784,7.654,1.722\r\n\t\t\t\t\tc3.528-0.12,7.502-2.757,8.912-4.601c1.293-1.69,1.992-3.875,2.188-5.813c0.412-4.076-1.01-6.284-3.625-9.315\r\n\t\t\t\t\tc-2.272-2.635-6.549-5.728-9.724-7.159c-1.717-0.773-7.144-1.619-7.144-1.619S144.563,144.764,142.832,145.464z\"></path>\r\n\t\t\t\t<path id=\"_x34__16_\" class=\"ring2_1\" d=\"M144.972,158.412c1.312,1.572,3.708,1.816,5.596,1.189\r\n\t\t\t\t\tc1.715-0.569,2.669-2.623,2.576-4.422c-0.082-1.572-0.441-3.025-0.922-4.5c-0.383-1.174-0.696-2.716-1.531-3.68\r\n\t\t\t\t\tc-0.974-0.181-1.727-0.299-1.727-0.299s-1.388,0.327-3.121,0.834c-1.01,1.463-1.651,3.42-2.089,5.082\r\n\t\t\t\t\tC143.203,154.706,143.54,156.695,144.972,158.412z\"></path>\r\n\t\t\t\t<path id=\"_x32__16_\" class=\"ring2_2\" d=\"M154.68,147.997c-0.803-0.362-2.617-0.743-3.989-0.997\r\n\t\t\t\t\tc0.835,0.964,1.148,2.506,1.531,3.68c0.481,1.475,0.84,2.928,0.922,4.5c0.093,1.799-0.861,3.853-2.576,4.422\r\n\t\t\t\t\tc-1.887,0.627-4.284,0.383-5.596-1.189c-1.433-1.717-1.769-3.706-1.218-5.795c0.438-1.662,1.079-3.619,2.089-5.082\r\n\t\t\t\t\tc-2.043,0.598-4.566,1.445-5.882,2.316c-2.545,1.684-7.254,8.016-5.129,13.328c1.404,3.51,3.429,5.056,6.554,4.992\r\n\t\t\t\t\tc2.975-0.061,5.099-1.69,8.009-1.867c2.063-0.125,6.383,1.694,8.216,1.402c4.097-0.652,5.745-5.465,5.659-8.09\r\n\t\t\t\t\tC163.086,154.041,157.219,149.142,154.68,147.997z\"></path>\r\n\t\t\t</g>\r\n\t\t</g>\r\n\t\t<g id=\"子房\">\r\n\t\t\t<g>\r\n\t\t\t\t<g id=\"_x35__19_\">\r\n\t\t\t\t\t<g>\r\n\t\t\t\t\t\t<path class=\"A5\" d=\"M155.19,76.942c-0.069-4.208-0.309-12.056-6.357-12.056c-4.258,0-5.835,4.599-6.137,8.043\r\n\t\t\t\t\t\t\tc-0.356,4.07-0.174,8.174-0.542,12.247c-0.098,1.081-0.231,2.159-0.449,3.222c-0.089,0.433-0.33,2.48-0.709,2.692\r\n\t\t\t\t\t\t\tc1.541-0.862,2.551-3.133,2.795-4.519c0.619-3.514,0.529-7,0.51-10.571c-0.012-2.192-0.088-4.8,0.858-6.834\r\n\t\t\t\t\t\t\tc1.204-2.589,4.679-3.027,6.653-1.049c1.382,1.385,1.315,5.694,1.307,7.537c-0.021,4.595-0.161,6.917,0.187,11.377\r\n\t\t\t\t\t\t\tc0.065,0.832,0.791,2.37,1.465,2.905c0.525,0.417,1.115,0.538,1.717,0.606C155.051,86.132,155.266,81.506,155.19,76.942z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g>\r\n\t\t\t\t\t\t<path class=\"A5 A6\" d=\"M155.19,76.942c-0.069-4.208-0.309-12.056-6.357-12.056\r\n\t\t\t\t\t\t\tc-4.258,0-5.835,4.599-6.137,8.043c-0.356,4.07-0.174,8.174-0.542,12.247c-0.098,1.081-0.231,2.159-0.449,3.222\r\n\t\t\t\t\t\t\tc-0.089,0.433-0.33,2.48-0.709,2.692c1.541-0.862,2.551-3.133,2.795-4.519c0.619-3.514,0.529-7,0.51-10.571\r\n\t\t\t\t\t\t\tc-0.012-2.192-0.088-4.8,0.858-6.834c1.204-2.589,4.679-3.027,6.653-1.049c1.382,1.385,1.315,5.694,1.307,7.537\r\n\t\t\t\t\t\t\tc-0.021,4.595-0.161,6.917,0.187,11.377c0.065,0.832,0.791,2.37,1.465,2.905c0.525,0.417,1.115,0.538,1.717,0.606\r\n\t\t\t\t\t\t\tC155.051,86.132,155.266,81.506,155.19,76.942z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t</g>\r\n\t\t\t\t<g id=\"_x32__17_\">\r\n\t\t\t\t\t<g>\r\n\t\t\t\t\t\t<path class=\"heart_1\" d=\"M175.811,105.815c-3.15-2.463-12.125-6.861-18.109-13.008c-0.501-0.515-0.897-1.296-1.212-2.264\r\n\t\t\t\t\t\t\tc-0.603-0.068-1.192-0.189-1.717-0.606c-0.675-0.535-1.4-2.073-1.465-2.905c-0.348-4.46-0.207-6.782-0.187-11.377\r\n\t\t\t\t\t\t\tc0.008-1.843,0.075-6.152-1.307-7.537c-1.974-1.979-5.449-1.541-6.653,1.049c-0.946,2.034-0.87,4.642-0.858,6.834\r\n\t\t\t\t\t\t\tc0.019,3.571,0.109,7.057-0.51,10.571c-0.244,1.386-1.255,3.656-2.795,4.519c-0.28,0.717-0.615,1.303-1.018,1.717\r\n\t\t\t\t\t\t\tc-5.984,6.146-14.959,10.545-18.11,13.007c-6.738,5.266-15.492,21.933,0.303,33.501c4.47,3.274,18.578,8.778,26.117,8.778\r\n\t\t\t\t\t\t\tc6.916,0,20.765-5.504,25.235-8.778C189.32,127.747,182.55,111.08,175.811,105.815z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t\t<g>\r\n\t\t\t\t\t\t<path class=\"heart_2 A6\" d=\"M175.811,105.815c-3.15-2.463-12.125-6.861-18.109-13.008\r\n\t\t\t\t\t\t\tc-0.501-0.515-0.897-1.296-1.212-2.264c-0.603-0.068-1.192-0.189-1.717-0.606c-0.675-0.535-1.4-2.073-1.465-2.905\r\n\t\t\t\t\t\t\tc-0.348-4.46-0.207-6.782-0.187-11.377c0.008-1.843,0.075-6.152-1.307-7.537c-1.974-1.979-5.449-1.541-6.653,1.049\r\n\t\t\t\t\t\t\tc-0.946,2.034-0.87,4.642-0.858,6.834c0.019,3.571,0.109,7.057-0.51,10.571c-0.244,1.386-1.255,3.656-2.795,4.519\r\n\t\t\t\t\t\t\tc-0.28,0.717-0.615,1.303-1.018,1.717c-5.984,6.146-14.959,10.545-18.11,13.007c-6.738,5.266-15.492,21.933,0.303,33.501\r\n\t\t\t\t\t\t\tc4.47,3.274,18.578,8.778,26.117,8.778c6.916,0,20.765-5.504,25.235-8.778C189.32,127.747,182.55,111.08,175.811,105.815z\"></path>\r\n\t\t\t\t\t</g>\r\n\t\t\t\t</g>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path id=\"_x35__17_\" class=\"A5 A6\" d=\"M137.864,83.014\r\n\t\t\t\t\tc-0.084-0.356-0.206-0.705-0.412-1.03c-0.16-0.252-0.351-0.465-0.559-0.648c-1.339-1.013-3.569-1.026-3.569-1.026\r\n\t\t\t\t\tc1.277,0.412,2.194,1.036,2.571,1.761c0.641,1.231,0.051,2.19-0.708,3.235c-0.776,1.069-1.683,1.231-2.628,2.104\r\n\t\t\t\t\tc-1.083,0.999-1.912,1.074-2.935-0.005c-1.593-1.68-3.612-1.499-3.36-3.985c0.149-1.475,1.11-2.098,1.11-2.098\r\n\t\t\t\t\ts-2-3.333,0.898-3.935c1.24-0.257,2.644,0.098,3.852-0.315c1.276-0.436,3.643-2.068,4.953-2.477\r\n\t\t\t\t\tc3.547-1.106,7.855,2.061,7.13,6.643c-0.417,2.634-1.165,5.251-2.417,7.584c-1.184,2.206-2.726,4.018-4.52,5.75\r\n\t\t\t\t\tc-1.813,1.75-10.847,6.685-13.229,8.417c-2.166,1.575-4.976,5.151-6.437,7.916c-1.396,2.642-2.814,5.515-2.938,8.556\r\n\t\t\t\t\tc-0.128,3.159,0.7,6.569,1.914,9.406c2.361,5.516,7.142,9.675,11.5,13.625c3.475,3.149,6.125,3.873,11.873,3.501\r\n\t\t\t\t\tc0.117-0.008,0.231-0.005,0.347-0.003c-10.878-2.673-19.387-10.874-22.76-22.842c-3.127-11.092,10.984-21.594,15.298-22.975\r\n\t\t\t\t\tc6.475-2.074,17.867-17.53,11.117-25.28c-2.829-3.248-6.589-3.754-8.932-1.764c-1.619,1.375-3.547,2.263-5.113,1.975\r\n\t\t\t\t\tc-3.275-0.603-6.057,2.413-5.571,5.285c-1.7,2.155-0.89,4.707,3.238,8.537c4.128,3.829,5.504,0.479,7.811-0.958\r\n\t\t\t\t\tc0.063-0.039,0.113-0.087,0.173-0.128C136.164,87.376,138.15,85.63,137.864,83.014z\"></path>\r\n\t\t\t\t<path id=\"_x35__18_\" class=\"A5 A6\" d=\"M159.71,146.496\r\n\t\t\t\t\tc2.073-0.518,8.248-3.11,10.122-4.254c2.756-1.682,5.639-4.661,7.875-7.5c2.305-2.927,4.057-8.813,4.5-10.493\r\n\t\t\t\t\tc0.488-1.854,0.225-4.156,0.125-6.132c-0.185-3.644-2.04-7.015-4-10.125c-1.127-1.79-2.738-2.992-4.334-4.32\r\n\t\t\t\t\tc-1.822-1.518-3.39-3.049-5.583-4.022c-2.448-1.086-7.293-3.802-9.082-5.907c-1.333-1.569-4.063-5.352-4.844-7.125\r\n\t\t\t\t\tc-1.448-3.288-1.427-7.753,0.997-10.597c2.153-2.527,7.813-2.935,10.128-0.934c1.468,1.269,3.015,2.088,5.101,1.912\r\n\t\t\t\t\tc1.035-0.087,1.689-0.63,2.247,0.615c0.404,0.901-0.141,1.859,0.247,2.753c0.462,1.066,1.154,0.91,0.465,2.222\r\n\t\t\t\t\tc-0.281,0.534-0.972,1.31-1.435,1.81c-0.98,1.059-2.389,2.939-3.906,2.996c-3.729,0.141-4.156-5.529-1.677-7.029\r\n\t\t\t\t\tc-0.771,0.091-1.969,0.333-2.813,0.974c-0.207,0.182-0.396,0.395-0.555,0.645c-0.205,0.324-0.326,0.672-0.41,1.026\r\n\t\t\t\t\tc-0.29,2.617,1.698,4.364,2.301,4.829c0.061,0.04,0.111,0.089,0.174,0.128c2.307,1.437,2.727,3.23,6.855-0.599\r\n\t\t\t\t\tc4.128-3.83,4.7-5.57,3-7.726c0.486-2.872-1.103-5.142-4.378-4.539c-1.565,0.288-3.495-0.6-5.113-1.975\r\n\t\t\t\t\tc-2.341-1.99-5.611-2.867-10.198,0.637c-10.339,7.899,2.996,24.373,9.47,26.408c5.47,1.72,18.552,11.919,15.298,22.975\r\n\t\t\t\t\tc-3.659,12.434-11.961,20.984-25.101,23.213c0.329,0.167,0.664,0.324,1.023,0.381C157.341,146.92,158.698,146.748,159.71,146.496\r\n\t\t\t\t\tz\"></path>\r\n\t\t\t\t<path id=\"_x34__17_\" class=\"heart_1 A6\" d=\"M185.061,99.295\r\n\t\t\t\t\tc-3.643-4.468-11.214-7.978-14.916-8.217c-2.163-0.239-4.794-3.111-4.794-3.111s-0.068-0.047-0.174-0.128\r\n\t\t\t\t\tc-1.796-1.206-2.703-3.139-2.301-4.829c0.003-0.029,0.002-0.058,0.006-0.087c0.09-0.701,0.466-1.209,0.959-1.584\r\n\t\t\t\t\tc0.91-0.801,2.169-0.99,2.925-1.028c0.14-0.076,0.283-0.147,0.44-0.195c-0.157,0.048-0.3,0.119-0.44,0.195\r\n\t\t\t\t\tc0.385-0.02,0.648-0.002,0.648-0.002s-0.308,0.002-0.76,0.056c-2.479,1.5-2.053,7.169,1.677,7.029\r\n\t\t\t\t\tc1.517-0.057,2.925-1.938,3.906-2.996c0.462-0.5,1.154-1.275,1.435-1.81c0.689-1.312-0.003-1.155-0.465-2.222\r\n\t\t\t\t\tc-0.388-0.895,0.157-1.852-0.247-2.753c-0.558-1.245-1.212-0.702-2.247-0.615c-2.085,0.176-3.633-0.644-5.101-1.912\r\n\t\t\t\t\tc-2.314-2.001-7.975-1.593-10.128,0.934c-2.423,2.844-2.444,7.309-0.997,10.597c0.781,1.773,3.51,5.556,4.844,7.125\r\n\t\t\t\t\tc1.789,2.105,6.634,4.821,9.082,5.907c2.194,0.974,3.761,2.505,5.583,4.022c1.597,1.328,3.207,2.53,4.334,4.32\r\n\t\t\t\t\tc1.96,3.11,3.816,6.481,4,10.125c0.1,1.976,0.363,4.278-0.125,6.132c-0.443,1.681-2.195,7.566-4.5,10.493\r\n\t\t\t\t\tc-2.236,2.839-5.119,5.818-7.875,7.5c-1.874,1.144-8.048,3.736-10.122,4.254c-1.012,0.252-2.369,0.425-3.503,0.246\r\n\t\t\t\t\tc-0.359-0.057-0.694-0.214-1.023-0.381c-2.036,0.346-4.179,0.551-6.449,0.583c-2.93,0.042-5.751-0.295-8.434-0.954\r\n\t\t\t\t\tc-0.115-0.002-0.23-0.005-0.347,0.003c-5.748,0.372-8.398-0.352-11.873-3.501c-4.358-3.95-9.139-8.109-11.5-13.625\r\n\t\t\t\t\tc-1.214-2.837-2.042-6.247-1.914-9.406c0.124-3.041,1.542-5.914,2.938-8.556c1.461-2.765,4.271-6.341,6.437-7.916\r\n\t\t\t\t\tc2.382-1.732,11.417-6.667,13.229-8.417c1.794-1.732,3.336-3.544,4.52-5.75c1.253-2.333,2.001-4.95,2.417-7.584\r\n\t\t\t\t\tc0.725-4.583-3.583-7.75-7.13-6.643c-1.31,0.409-3.677,2.041-4.953,2.477c-1.208,0.413-2.611,0.058-3.852,0.315\r\n\t\t\t\t\tc-2.898,0.601-0.898,3.935-0.898,3.935s-0.961,0.623-1.11,2.098c-0.252,2.486,1.768,2.306,3.36,3.985\r\n\t\t\t\t\tc1.023,1.079,1.853,1.004,2.935,0.005c0.945-0.873,1.852-1.035,2.628-2.104c0.759-1.045,1.349-2.004,0.708-3.235\r\n\t\t\t\t\tc-0.377-0.725-1.293-1.349-2.571-1.761c0,0,2.196-0.179,3.569,1.026c0.496,0.377,0.873,0.885,0.964,1.588\r\n\t\t\t\t\tc0.004,0.031,0.003,0.061,0.006,0.091c0.4,1.689-0.507,3.621-2.302,4.825c-0.105,0.081-0.173,0.128-0.173,0.128\r\n\t\t\t\t\ts-2.63,2.872-4.794,3.111c-3.701,0.239-14.187,3.749-17.83,8.217c-5.658,6.94-11.008,17.87-3.48,33.665\r\n\t\t\t\t\tc7.527,15.796,25.948,15.432,39.627,15.433c14.665,0.001,32.101,0.363,39.629-15.433\r\n\t\t\t\t\tC196.069,117.166,190.718,106.237,185.061,99.295z\"></path>\r\n\t\t\t</g>\r\n\t\t</g>\r\n\t\t<g id=\"花蕊_1_\">\r\n\t\t\t<path class=\"bud A6\" d=\"M140.729,115.414c-2.194,0.591-5.006,5.181,0.898,9.046\r\n\t\t\t\tc3.797,2.485,5.248,10.909,3.797,11.807c-1.45,0.897,0.345,2.555,1.519,1.302c0.84-0.898,1.381-7.378-0.276-10.209\r\n\t\t\t\ts-6.947-6.218-5.773-7.805c1.174-1.589,1.286-0.066,1.838-1.586C143.396,116.141,141.512,115.203,140.729,115.414z\"></path>\r\n\t\t\t<path class=\"bud A6\" d=\"M135.299,116.91c-2.194,0.591-5.007,5.18,0.897,9.045\r\n\t\t\t\tc3.797,2.485,5.248,10.909,3.797,11.807c-1.45,0.898,0.345,2.556,1.519,1.302c0.84-0.897,1.381-7.378-0.276-10.208\r\n\t\t\t\tc-1.657-2.832-6.947-6.218-5.773-7.806c1.173-1.588,1.286-0.066,1.838-1.585C137.965,117.636,136.082,116.698,135.299,116.91z\"></path>\r\n\t\t\t<path class=\"bud A6\" d=\"M123.329,122.801c0.005-0.674,0.207-2.14,1.726-2.071\r\n\t\t\t\tc1.519,0.069,1.519,1.175,1.45,2.141c-0.069,0.967-0.644,3.102,0.421,5.662c0.891,2.141,2.747,4.776,4.619,6.836\r\n\t\t\t\tc2.106,2.317,3.551,4.478,4.972,4.833c3.038,0.76-0.13,3.38-0.504,2.529c-0.808-1.839-6.452-7.112-7.919-8.743\r\n\t\t\t\tC125.449,131.049,123.307,125.702,123.329,122.801z\"></path>\r\n\t\t\t<path class=\"bud A6\" d=\"M129.474,123.699c0,0-2.21-2.83-0.76-3.521\r\n\t\t\t\tc1.45-0.69,2.668,1.478,2.762,1.622c1.194,1.853,5.507,8.803,6.624,16.219c0.557,3.702-0.279,3.086-0.279,3.086l-1.167,0.201\r\n\t\t\t\tc0.001,0.026-0.699-8.446-2.762-11.052C131.967,127.823,129.474,123.699,129.474,123.699z\"></path>\r\n\t\t\t<path class=\"bud A6\" d=\"M152.188,114.469c2.194,0.591,3.732,6.259-0.204,9.782\r\n\t\t\t\tc-3.978,3.562-5.041,11.601-3.591,12.498s-0.345,2.555-1.519,1.301c-0.84-0.896-1.381-7.377,0.276-10.208\r\n\t\t\t\tc1.657-2.831,6.047-7.645,4.873-9.232c-1.173-1.589-1.286-0.066-1.838-1.586C149.521,115.197,151.404,114.258,152.188,114.469z\"></path>\r\n\t\t\t<path class=\"bud A6\" d=\"M157.618,115.964c2.194,0.592,5.007,5.181-0.897,9.046\r\n\t\t\t\tc-3.798,2.485-5.248,10.909-3.798,11.807c1.45,0.898-0.345,2.555-1.519,1.302c-0.84-0.898-1.381-7.377,0.276-10.209\r\n\t\t\t\tc1.657-2.831,6.947-6.218,5.774-7.805c-1.174-1.589-1.286-0.066-1.838-1.586C154.951,116.692,156.834,115.754,157.618,115.964z\"></path>\r\n\t\t\t<path class=\"bud A6\" d=\"M174.623,122.006c-0.005-0.675-0.207-2.141-1.726-2.071\r\n\t\t\t\tc-1.519,0.068-1.519,1.173-1.45,2.141c0.069,0.966,0.644,3.101-0.421,5.661c-0.891,2.141-2.747,4.776-4.619,6.836\r\n\t\t\t\tc-2.106,2.317-3.55,4.478-4.972,4.833c-3.038,0.76,0.13,3.379,0.504,2.528c0.808-1.838,6.452-7.111,7.92-8.742\r\n\t\t\t\tC172.503,130.254,174.645,124.906,174.623,122.006z\"></path>\r\n\t\t\t<path class=\"bud A6\" d=\"M168.478,122.904c0,0,2.209-2.831,0.76-3.521\r\n\t\t\t\tc-1.45-0.69-2.668,1.478-2.762,1.622c-1.194,1.853-5.507,8.803-6.624,16.219c-0.558,3.701,0.278,3.086,0.278,3.086l1.167,0.201\r\n\t\t\t\tc0,0.026,0.699-8.446,2.762-11.052C165.985,127.027,168.478,122.904,168.478,122.904z\"></path>\r\n\t\t\t<path class=\"bud A6\" d=\"M162.647,116.91c2.194,0.591,5.008,5.18-0.897,9.045\r\n\t\t\t\tc-3.798,2.485-5.248,10.909-3.798,11.807c1.45,0.898-0.345,2.556-1.519,1.302c-0.84-0.897-1.381-7.378,0.276-10.208\r\n\t\t\t\tc1.657-2.832,6.947-6.218,5.774-7.806c-1.174-1.588-1.286-0.066-1.838-1.585C159.98,117.636,161.863,116.698,162.647,116.91z\"></path>\r\n\t\t</g>\r\n\t\t<g id=\"花瓣1\">\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"ring1_2 A6\" d=\"M153.802,147.675c0,0,8.5-3.189,12.333-6.189\r\n\t\t\t\t\tc2.271-1.777,8.479-5.666,10.669-10.182c1.193-2.463,3.145-4.235,5.061-4.545c1.844-0.298,2.75,1.893,2.75,1.893\r\n\t\t\t\t\ts2.75-7.333,7.25-4.333s-5.146,17.499-13.092,22.003C171.07,150.687,153.802,147.675,153.802,147.675z\"></path>\r\n\t\t\t\t<path class=\"ring1_1\" d=\"M165.718,148.444c4.653,0.008,9.627-0.519,12.888-2.366c1.133-0.643,2.301-1.488,3.457-2.475\r\n\t\t\t\t\tc0,0,1.616-2.262-0.753-3.103c-1.263-0.448-4.673,2.381-6.092,3.491C173.301,145.492,165.718,148.444,165.718,148.444z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"ring1_2 A6\" d=\"M144.635,147.431c0,0-12.75-4.939-16.417-8.272\r\n\t\t\t\t\tc-2.134-1.939-5.333-5.083-7.522-9.599c-1.194-2.463-3.145-4.234-5.061-4.545c-1.844-0.297-2.75,1.893-2.75,1.893\r\n\t\t\t\t\ts-2.75-7.332-7.25-4.332s2.417,15.199,9.614,20.357C124.051,149.242,144.635,147.431,144.635,147.431z\"></path>\r\n\t\t\t\t<path class=\"ring1_1\" d=\"M133.635,147.672c0,0-5.572-1.844-9.833-4.362c-3.5-2.068-5.417-4.902-7.917-4.985\r\n\t\t\t\t\ts-3.145,0.259-3.25,0.917C111.718,144.992,133.635,147.672,133.635,147.672z\"></path>\r\n\t\t\t</g>\r\n\t\t\t<g>\r\n\t\t\t\t<path class=\"ring1_2 A6\" d=\"M142.885,137.653c0,0-1.496-1.38-3.905-1.335\r\n\t\t\t\t\tc-4.902,0.134-4.483,4.994-4.221,6.466c0.167,1.112,1.5,7.397,12.779,7.376c12.224-0.023,14.013-6.688,14.013-8.334\r\n\t\t\t\t\tc0-2.805-2.143-3.515-3.495-3.836c-2.674-0.636-5.531-0.203-5.531-0.203s-2.182-1.87-4.705-1.959\r\n\t\t\t\t\tC145.294,135.739,142.885,137.653,142.885,137.653z\"></path>\r\n\t\t\t\t<path class=\"ring1_1\" d=\"M147.539,150.478c-3.365,0-6.979-6.495,0.473-6.486\r\n\t\t\t\t\tC153.549,143.999,152.788,150.478,147.539,150.478z\"></path>\r\n\t\t\t</g>\r\n\t\t</g>\r\n\t</g>\r\n</svg>";

},{}],31:[function(require,module,exports){
'use strict';

var _svg = require('svg.js');

var _svg2 = _interopRequireDefault(_svg);

var _concaveman = require('concaveman');

var _concaveman2 = _interopRequireDefault(_concaveman);

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _LeafImage = require('../src/images/LeafImage');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function getPathPoints(svg, draw) {
	var commands = svg.select('path').members.map(function (p) {
		return draw.path(p.node.getAttribute('d')).array().value;
	});

	return (0, _lodash2.default)(commands).flatten().map(function (cmd) {
		return (0, _lodash2.default)(cmd).filter(function (x) {
			return typeof x === 'number';
		}).chunk(2).value();
	}).flatten().value();
}

function concaveSVG(flowerString, concave, length) {
	var draw = (0, _svg2.default)('drawing').size(300, 300);

	var flower = draw.svg(flowerString);
	var points = getPathPoints(flower, draw).filter(function (x) {
		return typeof x[0] === 'number' && typeof x[1] === 'number';
	});
	var polygon = (0, _concaveman2.default)(points, concave, length);
	draw.polygon().plot(polygon).fill('none').stroke({ width: 3 }).stroke('red');

	return polygon;
}

function 正面() {
	var flowerString = require('../src/images/海石榴心_v3.svg');
	concaveSVG(flowerString, 1, 23);
}

正面();

function 側面() {
	var flowerString = require('../src/images/sideFlower_v6.svg');
	var draw = (0, _svg2.default)('drawing').size(300, 300);

	var flower = draw.svg(flowerString);
	var points = getPathPoints(flower, draw).filter(function (x) {
		return typeof x[0] === 'number' && typeof x[1] === 'number';
	});
	var polygon = (0, _concaveman2.default)(points, 1.6, 55);
	_svg2.default.adopt(flower.select('#SvgjsG1684').members[0].node).polygon().plot(polygon).fill('none').stroke({ width: 3 }).stroke('red');
}

側面();

function leaf() {
	var json = [];
	_lodash2.default.range(6).forEach(function (i) {
		var polygon = concaveSVG(_LeafImage.LeafImage[i], 2, 45);
		json.push(polygon);
	});
	console.log(JSON.stringify(json));
}
leaf();

},{"../src/images/LeafImage":15,"../src/images/sideFlower_v6.svg":29,"../src/images/海石榴心_v3.svg":30,"concaveman":1,"lodash":2,"svg.js":11}]},{},[31])