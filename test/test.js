'use strict'

var test = require('tape')
var afterAll = require('after-all')
var packages = require('./packages')
var tests = require('./data')
var db = require('../')(require('memdb')())

var next = afterAll(function (err) {
  if (err) throw err

  tests.forEach(function (target) {
    target.groups.forEach(function (group) {
      group.ranges.forEach(function (range) {
        var matches = group.defaultMatches

        if (Array.isArray(range)) {
          matches = matches.concat(range.splice(1, range.length - 1))
          range = range[0]
        }

        matches = packages.filter(function (pkg) {
          return matches.some(function (name) {
            return pkg.name === name
          })
        }).sort(byName)

        test('\'' + range + '\' ' + group.description, function (t) {
          db.query(target.name, range, function (err, results) {
            t.error(err)
            t.deepEqual(results && results.sort(byName), matches)
            t.end()
          })
        })
      })
    })
  })

  test('devDependency', function (t) {
    db.query('dev', '*', {devDependencies: true}, function (err, results) {
      t.error(err)
      t.equal(results.length, 1)
      t.equal(results[0].name, 'foo')
      t.deepEqual(results[0].devDependencies, {dev: '1.2.3'})
      t.end()
    })
  })

  test('latest, not latest', function (t) {
    db.query('old-dependency', '*', {latest: false}, function (err, results) {
      t.error(err)
      t.deepEqual(results, [{dependencies: {'old-dependency': '^1.0.0'}, name: 'latest', version: '1.0.0'}])
      t.end()
    })
  })

  test('latest, latest', function (t) {
    // validate that outdated dependency is present before query
    db._db.get('!index-latest!dep!old-dependency!latest', function (err, value) {
      t.error(err)

      db.query('old-dependency', '*', {latest: true}, function (err, results) {
        t.error(err)
        t.deepEqual(results, [])

        // validate that outdated dependency is pruned after query
        db._db.get('!index-latest!dep!old-dependency!latest', function (err, value) {
          t.ok(err.notFound)
          t.end()
        })
      })
    })
  })
})

packages.forEach(function (pkg) {
  db.store(pkg, next())
})

function byName (a, b) {
  return a.name > b.name
}
