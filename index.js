'use strict'

var semver = require('semver')
var lexi = require('lexicographic-integer')
var through = require('through2')
var pump = require('pump')
var collect = require('stream-collector')
var lru = require('hashlru')(1000)

module.exports = Db

// Database Schema:
//
// !pkg!<module-name>@<version>                  - package.json of specific version
// !pkg-latest!<module-name>                     - package.json of latest version
// !latest-version!<module-name>                 - version number of latest version of module
// !index!dev!<dependency>!<dependant>@<version> - dependency range for specific version dependency
// !index!dep!<dependency>!<dependant>@<version> - dependency range for specific version devDependency
// !index-latest!dev!<dependency>!<dependant>    - dependency range for latest version dependency
// !index-latest!dep!<dependency>!<dependant>    - dependency range for latest version devDependency

function Db (db) {
  if (!(this instanceof Db)) return new Db(db)
  this._db = db
}

Db.prototype.store = function (pkg, cb) {
  var self = this

  this._getLatestVersion(pkg.name, function (err, latest) {
    if (err) return cb(err)
    var isLatest = latest ? semver.gt(pkg.version, latest) : true
    var dependant = escape(pkg.name)

    var batch = batchDependencies(pkg, pkg.dependencies, 'dep', isLatest)
      .concat(batchDependencies(pkg, pkg.devDependencies, 'dev', isLatest))

    batch.push({type: 'put', key: '!pkg!' + dependant + '@' + pkg.version, value: pkg, valueEncoding: 'json'})

    if (isLatest) {
      batch.push(
        {type: 'put', key: '!pkg-latest!' + dependant, value: pkg, valueEncoding: 'json'},
        {type: 'put', key: '!latest-version!' + dependant, value: pkg.version}
      )
      lru.set(pkg.name, pkg.version)
    }

    self._db.batch(batch, cb)
  })
}

Db.prototype._getLatestVersion = function (name, cb) {
  var latest = lru.get(name)
  if (latest) {
    process.nextTick(function () {
      cb(null, latest)
    })
  } else {
    var key = '!latest-version!' + escape(name)
    this._db.get(key, function (err, version) {
      if (err && !err.notFound) cb(err)
      else cb(null, version)
    })
  }
}

function batchDependencies (pkg, deps, deptype, isLatest) {
  deps = deps || {}
  var dependant = escape(pkg.name)
  var batch = []

  Object.keys(deps).forEach(function (dependency) {
    var range = deps[dependency]
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
            set[0].push(lexSemver({major: 0, minor: 0, patch: 0}))
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

    dependency = escape(dependency)

    var key = '!index!' + deptype + '!' + dependency + '!' + dependant + '@' + pkg.version // example: !index!dep!request!zulip@0.1.0
    batch.push({type: 'put', key: key, value: value, valueEncoding: 'json'})

    if (isLatest) {
      var latestKey = '!index-latest!' + deptype + '!' + dependency + '!' + dependant // example: !index-latest!dep!request!zulip
      batch.push({type: 'put', key: latestKey, value: {version: pkg.version, sets: value}, valueEncoding: 'json'})
    }
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

  var keyprefix = opts.latest ? '!index-latest!' : '!index!'
  keyprefix += opts.devDependencies ? 'dev!' : 'dep!'

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
    var sets = opts.latest ? data.value.sets : data.value
    if (wildcard || match(sets, lquery, uquery)) {
      // get dependant from key:
      //   !index!dep!request!zulip@0.1.0 => zulip@0.1.0
      //   !index!dep!request!zulip       => zulip (if latest only)
      var dependant = data.key.substr(data.key.lastIndexOf('!') + 1)
      var key = (opts.latest ? '!pkg-latest!' : '!pkg!') + dependant
      self._db.get(key, {valueEncoding: 'json'}, function (err, pkg) {
        if (err) return cb(err)
        if (!opts.latest) return cb(null, pkg)
        var deps = opts.devDependencies ? pkg.devDependencies : pkg.dependencies
        if (deps && name in deps) return cb(null, pkg)
        self._db.del(data.key, cb) // clean up out of date index
      })
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
        return [{major: 0, minor: 0, patch: 0}, lower.semver]
      case '<=':
        return [
          {major: 0, minor: 0, patch: 0},
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
