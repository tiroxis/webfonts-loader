var loaderUtils = require('loader-utils');
var webfontsGenerator = require('webfonts-generator');
var _ = require('underscore')
var handlebars = require('handlebars')
var path = require('path');
var fs = require('fs')
var glob = require('glob');
var url = require('url');
var mkdirp = require('mkdirp')
var hashFiles = require('./utils').hashFiles;

var SCSS_TEMPLATE = path.join(__dirname, 'templates', 'scss.hbs')

var mimeTypes = {
  'eot': 'application/vnd.ms-fontobject',
  'svg': 'image/svg+xml',
  'ttf': 'application/x-font-ttf',
  'woff': 'application/font-woff',
  'woff2': 'font/woff2'
};

function getFilesAndDeps (patterns, context) {
  var files = [];
  var filesDeps = [];
  var directoryDeps = [];

  function addFile (file) {
    filesDeps.push(file);
    files.push(path.resolve(context, file));
  }

  function addByGlob (globExp) {
    var globOptions = {cwd: context};

    var foundFiles = glob.sync(globExp, globOptions);
    files = files.concat(foundFiles.map(file => {
      return path.resolve(context, file);
    }));

    var globDirs = glob.sync(path.dirname(globExp) + '/', globOptions);
    directoryDeps = directoryDeps.concat(globDirs.map(file => {
      return path.resolve(context, file);
    }));
  }

  // Re-work the files array.
  patterns.forEach(function (pattern) {
    if (glob.hasMagic(pattern)) {
      addByGlob(pattern);
    } else {
      addFile(pattern);
    }
  });

  return {
    files: files,
    dependencies: {
      directories: directoryDeps,
      files: filesDeps
    }
  };
}

// Futureproof webpack option parsing
function wpGetOptions (context) {
  if (typeof context.query === 'string') return loaderUtils.getOptions(context);
  return context.query;
}

function writeFile(content, dest) {
  mkdirp.sync(path.dirname(dest))
  fs.writeFileSync(dest, content)
}

module.exports = function (content) {
  this.cacheable();

  var webpackOptions = this.options || {}; // only makes sense in Webpack 1.x, or when LoaderOptionsPlugin is used
  var options = wpGetOptions(this) || {};
  var rawFontConfig;
  try {
    rawFontConfig = JSON.parse(content);
  } catch (ex) {
    rawFontConfig = this.exec(content, this.resourcePath);
  }
  var fontConfig = Object.assign({}, options, rawFontConfig);

  var filesAndDeps = getFilesAndDeps(fontConfig.files, this.context);
  filesAndDeps.dependencies.files.forEach(this.addDependency.bind(this));
  filesAndDeps.dependencies.directories.forEach(this.addContextDependency.bind(this));
  fontConfig.files = filesAndDeps.files;

  // With everything set up, let's make an ACTUAL config.
  var formats = fontConfig.types || ['eot', 'woff', 'woff2', 'ttf', 'svg'];
  if (formats.constructor !== Array) {
    formats = [formats];
  }

  var generatorOptions = {
    files: fontConfig.files,
    fontName: fontConfig.fontName,
    types: formats,
    order: formats,
    fontHeight: fontConfig.fontHeight || 1000, // Fixes conversion issues with small svgs,
    codepoints: fontConfig.codepoints || {},
    templateOptions: {
      baseSelector: fontConfig.baseSelector || '.icon',
      classPrefix: 'classPrefix' in fontConfig ? fontConfig.classPrefix : 'icon-'
    },
    dest: '',
    writeFiles: fontConfig.writeFiles || false,
    embed: fontConfig.embed || false,
    formatOptions: fontConfig.formatOptions || {}
  };

  // This originally was in the object notation itself.
  // Unfortunately that actually broke my editor's syntax-highlighting...
  // ... what a shame.
  if (typeof fontConfig.rename === 'function') {
    generatorOptions.rename = fontConfig.rename;
  } else {
    generatorOptions.rename = function (f) {
      return path.basename(f, '.svg');
    };
  }

  if (fontConfig.cssTemplate) {
    generatorOptions.cssTemplate = path.resolve(this.context, fontConfig.cssTemplate);
  }

  if (fontConfig.cssFontsPath) {
    generatorOptions.cssFontsPath = path.resolve(this.context, fontConfig.cssFontsPath);
  }

  // svgicons2svgfont stuff
  var keys = [
    'fixedWidth',
    'centerHorizontally',
    'normalize',
    'fontHeight',
    'round',
    'descent'
  ];
  for (var x in keys) {
    if (typeof fontConfig[keys[x]] !== 'undefined') {
      generatorOptions[keys[x]] = fontConfig[keys[x]];
    }
  }

  var cb = this.async();

  var publicPath = options.publicPath || (webpackOptions.output && webpackOptions.output.publicPath) || '/';
  var embed = !!generatorOptions.embed;

  if (generatorOptions.cssTemplate) {
    this.addDependency(generatorOptions.cssTemplate);
  }

  if (generatorOptions.cssFontsPath) {
    this.addDependency(generatorOptions.cssFontsPath);
  }

  webfontsGenerator(generatorOptions, (err, res) => {
    if (err) {
      return cb(err);
    }
    var urls = {};
    for (var i in formats) {
      var format = formats[i];
      var filename = fontConfig.fileName || options.fileName || '[chunkhash]-[fontname].[ext]';
      var chunkHash = filename.indexOf('[chunkhash]') !== -1
        ? hashFiles(generatorOptions.files, options.hashLength) : '';

      filename = filename
        .replace('[chunkhash]', chunkHash)
        .replace('[fontname]', generatorOptions.fontName)
        .replace('[ext]', format);

      if (!embed) {
        var formatFilename = loaderUtils.interpolateName(this,
          filename,
          {
            context: this.rootContext || this.options.context || this.context,
            content: res[format]
          }
        );
        urls[format] = url.resolve(publicPath, formatFilename.replace(/\\/g, '/'));
        this.emitFile(formatFilename, res[format]);
      } else {
        urls[format] = 'data:' +
          mimeTypes[format] +
          ';charset=utf-8;base64,' +
          (Buffer.from(res[format]).toString('base64'));
      }
    }

    if(fontConfig.scssDest) {
      const scssDest = path.resolve(this.context, fontConfig.scssDest)
      const templateDist = fontConfig.scssTemplate ? path.resolve(this.context, fontConfig.scssTemplate) :  SCSS_TEMPLATE
      var source = fs.readFileSync(templateDist, 'utf8')
      var template = handlebars.compile(source)
      var ctx = {
        fontName: generatorOptions.fontName,
        codepoints: _.object(_.map(generatorOptions.codepoints, function(codepoint, name) {
          return [name, codepoint.toString(16)]
        }))
      }
      writeFile(template(ctx), scssDest)
    }

    cb(null, res.generateCss(urls));
  });
};
