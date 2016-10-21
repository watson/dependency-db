'use strict'

var semver = require('semver')
var lexi = require('lexicographic-integer')
var through = require('through2')
var pump = require('pump')
var collect = require('stream-collector')

module.exports = Db

function Db (db) {
  if (!(this instanceof Db)) return new Db(db)
  this._db = db
}

Db.prototype.store = function (pkg, cb) {
  var batch = []
  var deps = pkg.dependencies || {}
  var id = pkg.name + '@' + pkg.version

  Object.keys(deps).forEach(function (name) {
    var range = deps[name]
    try {
      var sets = semver.Range(range).set
    } catch (e) {
      return
    }
    sets.forEach(function (set) {
      var key = genkey(id, name, set)
      batch.push({ type: 'put', key: key, value: id })
    })
  })

  batch.push({ type: 'put', key: '!pkg!' + id, value: pkg, valueEncoding: 'json' })

  this._db.batch(batch, cb)
}

Db.prototype.query = function (name, range, cb) {
  range = semver.Range(range)

  var wildcard = range.range === '' // both '*', 'x' and '' will be compiled to ''
  var stream = this._db.createReadStream({
    gt: '!index!' + name + '!',
    lt: '!index!' + name + '!\xff'
  })

  if (range.set.length !== 1) return cb(new Error('OR-range queries not supported'))

  if (!wildcard) {
    var norm = normalize(range.set[0])
    var lquery = norm[0] ? lexSemver(norm[0]) : '\x00'
    var uquery = norm[1] ? lexSemver(norm[1]) : '\xff'
  }

  var self = this
  var filter = through.obj(function (data, enc, cb) {
    if (!wildcard) {
      var parts = data.key.split('!')
      var lower = parts.slice(4, 7).join('!')
      var upper = parts.slice(7).join('!')
    }

    if (wildcard || match(lower, upper, lquery, uquery)) {
      self._db.get('!pkg!' + data.value, { valueEncoding: 'json' }, cb)
    } else {
      cb()
    }
  })

  pump(stream, filter)

  return collect(filter, cb)
}

function match (lower, upper, lquery, uquery) {
  return (lquery >= lower && lquery < upper) || // lquery is inside
         (uquery > lower && uquery <= upper) || // uquery is inside
         (lquery <= lower && uquery >= upper)   // query spans
}

// pkg: name@version
// dep: name
// comparators: an array of semver.Comparator objects
function genkey (pkg, dep, comparators) {
  var norm = normalize(comparators)
  var lower = norm[0] ? lexSemver(norm[0]) : '\x00'
  var upper = norm[1] ? lexSemver(norm[1]) : '\xff'
  return '!index!' + dep + '!' + pkg + '!' + lower + '!' + upper
}

function normalize (comparators) {
  if (comparators.length > 2) throw new Error('More than two comparators not supported')

  var lower = comparators[0]
  var upper = comparators[1]

  if (!upper) {
    switch (lower.operator) {
      // match all, i.e. '*', 'x' and ''
      case undefined:
        return []
      // direct matches, e.g. '1.2.3' or '=1.2.3'
      case '':
        return [
          lower.semver,
          {
            major: lower.semver.major,
            minor: lower.semver.minor,
            patch: lower.semver.patch + 1
          }
        ]
      case '<':
        return [{ major: 0, minor: 0, patch: 0 }, lower.semver]
      case '<=':
        return [
          { major: 0, minor: 0, patch: 0 },
          {
            major: lower.semver.major,
            minor: lower.semver.minor,
            patch: lower.semver.patch + 1
          }
        ]
      case '>':
        return [{
          major: lower.semver.major,
          minor: lower.semver.minor,
          patch: lower.semver.patch + 1
        }]
      case '>=':
        return [lower.semver]
      default:
        throw new Error('Unexpected operator: ' + String(lower.operator))
    }
  }

  return [
    normalizeLower(lower),
    normalizeUpper(upper)
  ]
}

function normalizeLower (comp) {
  switch (comp.operator) {
    case '>=':
      return comp.semver
    case '>':
      comp.semver.patch++
      return comp.semver
    default:
      throw new Error('Unexpected lower operator: ' + String(comp.operator))
  }
}

function normalizeUpper (comp) {
  switch (comp.operator) {
    case '<':
      return comp.semver
    case '<=':
      comp.semver.patch++
      return comp.semver
    default:
      throw new Error('Unexpected upper operator: ' + String(comp.operator))
  }
}

function lexSemver (semver) {
  return lexi.pack(semver.major, 'hex') + '!' +
         lexi.pack(semver.minor, 'hex') + '!' +
         lexi.pack(semver.patch, 'hex')
}
