# dependency-db

A database for querying which packages depend on a specific package
within a specific range.

[![Build status](https://travis-ci.org/watson/dependency-db.svg?branch=master)](https://travis-ci.org/watson/dependency-db)
[![js-standard-style](https://img.shields.io/badge/code%20style-standard-brightgreen.svg?style=flat)](https://github.com/feross/standard)

## Installation

```
npm install dependency-db --save
```

## Usage

```js
var memdb = require('memdb')
var DependencyDb = require('dependency-db')

var db = new DependencyDb(memdb())

// pkg should be a package.json style object
var pkg = {
  name: 'foo',
  version: '1.2.3',
  dependencies: {
    bar: '^2.3.4'
  }
}

db.store(pkg, function (err) {
  if (err) throw err

  db.query('bar', '^2.0.0', function (err, pkgs) {
    if (err) throw err

    console.log('Found %d dependant package releases:', pkgs.length)

    pkgs.forEach(function (pkg) {
      console.log('- %s@%s', pkg.name, pkg.version)
    })
  })
})
```

## API

### `var db = new DependencyDb(levelup)`

Initialize the `DependencyDb` constructor with a `levelup` database
instance.

### `db.store(pkg, callback)`

Store a package in the database.

The first argument is a package.json style JavaScript object. Only
the `name` and `version` properties are required. If `dependencies` is
present, it should adhere the the regular package.json format.

The `callback` will be called with an optional error object as the first
arguement when the package have been processed and stored correctly in
the database.

### `db.query(name, range, callback)`

Query the database for packages that depend on `name` within the given
`range`.

The `callback` will be called with an optional error object as the first
arguement and an array of packages that match the query as the second.

## License

MIT