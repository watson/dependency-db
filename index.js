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
  var id = escape(pkg.name) + '@' + pkg.version

  var batch = batchDependencies(pkg.dependencies, '!index!dep', id)
    .concat(batchDependencies(pkg.devDependencies, '!index!dev', id))
    .concat({ type: 'put', key: '!pkg!' + id, value: pkg, valueEncoding: 'json' })

  this._db.batch(batch, cb)
}

function batchDependencies (deps, keyprefix, id) {
  deps = deps || {}
  var batch = []

  Object.keys(deps).forEach(function (name) {
    name = escape(name)
    var key = keyprefix + '!' + name + '!' + id // example: !index!dep!request!zulip@0.1.0
    var range = deps[name]
    try {
      var sets = semver.Range(range).set
    } catch (e) {
      return
    }
    var value = []
    sets.forEach(function (comparators) {
      var set = [[], []]
      value.push(set)

      comparators.forEach(function (comparator) {
        switch (comparator.operator) {
          case undefined: // 'match all' operator
            set[0].push(lexSemver({ major: 0, minor: 0, patch: 0 }))
            break
          case '': // equal operator
            set[0].push(lexSemver(comparator.semver))
            set[1].push(lexSemver({
              major: comparator.semver.major,
              minor: comparator.semver.minor,
              patch: comparator.semver.patch + 1
            }))
            break
          case '>':
          case '>=':
            set[0].push(lexSemver(comparator.semver))
            break
          case '<':
          case '<=':
            set[1].push(lexSemver(comparator.semver))
            break
          default:
            throw new Error('Unexpected operator: ' + String(comparator.operator))
        }
      })
    })
    batch.push({ type: 'put', key: key, value: value, valueEncoding: 'json' })
  })

  return batch
}

Db.prototype.query = function (name, range, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  } else if (!opts) {
    opts = {}
  }

  name = escape(name)
  range = semver.Range(range)

  var keyprefix = opts.devDependencies ? '!index!dev!' : '!index!dep!'
  var wildcard = range.range === '' // both '*', 'x' and '' will be compiled to ''
  var stream = this._db.createReadStream({
    gt: keyprefix + name + '!',
    lt: keyprefix + name + '!\xff',
    valueEncoding: 'json'
  })

  if (range.set.length !== 1) throw new Error('OR-range queries not supported')

  if (!wildcard) {
    var norm = normalize(range.set[0])
    var lquery = norm[0] ? lexSemver(norm[0]) : '\x00'
    var uquery = norm[1] ? lexSemver(norm[1]) : '\xff'
  }

  var self = this
  var filter = through.obj(function (data, enc, cb) {
    if (wildcard || match(data.value, lquery, uquery)) {
      // key example: !index!dep!request!zulip@0.1.0
      var id = data.key.substr(data.key.lastIndexOf('!') + 1) // id = 'zulip@0.1.0'
      self._db.get('!pkg!' + id, { valueEncoding: 'json' }, cb)
    } else {
      cb()
    }
  })

  pump(stream, filter)

  return collect(filter, cb)
}

function match (range, lquery, uquery) {
  return range.some(function (range) {
    var lower = range[0]
    var upper = range[1]

    if (lower.length === 0 && uquery <= '\x00') return false
    if (upper.length === 0 && lquery >= '\xff') return false

    var ok = lower.every(function (lower) {
      return uquery > lower
    })

    if (!ok) return false

    return upper.every(function (upper) {
      return lquery < upper
    })
  })
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
