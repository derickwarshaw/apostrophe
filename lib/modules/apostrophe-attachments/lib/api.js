var _ = require('lodash');
var async = require('async');
var crypto = require('crypto');
var path = require('path');
var fs = require('fs');
var Promise = require('bluebird');

module.exports = function(self, options) {

  // For backwards compatibility. Equivalent to calling `insert` with
  // the same three arguments.

  self.accept = function(req, file, callback) {
    self.insert(req, file, { permissions: true }, callback);
  };

  // Insert a file as an Apostrophe attachment. The `file` object
  // should be an object with `name` and `path` properties. 
  // `name` must be the name the user claims for the file, while `path`
  // must be the actual full path to the file on disk and need not have
  // any file extension necessarily.
  //
  // Note that when using Express to handle file uploads,
  // req.files['yourfieldname'] will be such an object as long as you
  // configure jquery fileupload to submit one per request.
  //
  // The `options` argument may be omitted completely.
  // If `options.permissions` is explicitly set to `false`,
  // permissions are not checked.
  //
  // `callback` is invoked with `(null, attachment)` where
  // `attachment` is an attachment object, suitable
  // for passing to the `url` API and for use as the value
  // of an `type: 'attachment'` schema field.
  //
  // If `callback` is omitted completely, a promise is returned.
  // The promise resolves to an attachment object.

  self.insert = function(req, file, options, callback) {

    if (typeof(arguments[2]) !== 'object') {
      callback = arguments[2];
      options = {};
    }

    if (callback) {
      return body(callback);
    } else {
      return Promise.promisify(body)();
    }

    function body(callback) {

      var extension = path.extname(file.name);
      if (extension && extension.length) {
        extension = extension.substr(1);
      }
      extension = extension.toLowerCase();
      // Do we accept this file extension?
      var group = self.getFileGroup(extension);
      if (!group) {
        var accepted = _.union(_.pluck(self.fileGroups, 'extensions'));
        return callback("File extension not accepted. Acceptable extensions: " + accepted.join(","));
      }
      var image = group.image;
      var info = {
        _id: self.apos.utils.generateId(),
        group: group.name,
        createdAt: new Date(),
        name: self.apos.utils.slugify(path.basename(file.name, path.extname(file.name))),
        title: self.apos.utils.sortify(path.basename(file.name, path.extname(file.name))),
        extension: extension,
        type: 'attachment',
        docIds: [],
        trashDocIds: []
      };

      function permissions(callback) {
        if (options && (options.permissions === false)) {
          return callback(null);
        }
        return callback(self.apos.permissions.can(req, 'edit-attachment') ? null : 'forbidden');
      }

      function length(callback) {
        return self.apos.utils.fileLength(file.path, function(err, size) {
          if (err) {
            return callback(err);
          }
          info.length = size;
          return callback(null);
        });
      }

      function md5(callback) {
        return self.apos.utils.md5File(file.path, function(err, md5) {
          if (err) {
            return callback(err);
          }
          info.md5 = md5;
          return callback(null);
        });
      }

      function upload(callback) {
        if (image) {
          // For images we correct automatically for common file extension mistakes
          return self.uploadfs.copyImageIn(file.path, '/attachments/' + info._id + '-' + info.name, function(err, result) {
            if (err) {
              return callback(err);
            }
            info.extension = result.extension;
            info.width = result.width;
            info.height = result.height;
            if (info.width > info.height) {
              info.landscape = true;
            } else {
              info.portrait = true;
            }
            return callback(null);
          });
        } else {
          // For non-image files we have to trust the file extension
          // (but we only serve it as that content type, so this should
          // be reasonably safe)
          return self.uploadfs.copyIn(file.path, '/attachments/' + info._id + '-' + info.name + '.' + info.extension, callback);
        }
      }

      function remember(callback) {
        if (!options || options && options.permissions !== false) {
          info.ownerId = self.apos.permissions.getEffectiveUserId(req);
        }
        info.createdAt = new Date();
        return self.db.insert(info, callback);
      }

      return async.series([ permissions, length, md5, upload, remember ], function(err) {
        return callback(err, info);
      });
    }

  };

  self.getFileGroup = function(extension) {
    return _.find(self.fileGroups, function(group) {
      var candidate = group.extensionMaps[extension] || extension;
      if (_.contains(group.extensions, candidate)) {
        return true;
      }
    });
  };

  self.crop = function(req, _id, crop, callback) {
    var info;
    return async.series([
      function(callback) {
        self.db.findOne({ _id: _id }, function(err, _info) {
          info = _info;
          return callback(err);
        });
      }
    ], function(err) {
      if (!info) {
        return callback('notfound');
      }
      info.crops = info.crops || [];
      var existing = _.find(info.crops, crop);
      if (existing) {
        // We're done, this crop is already available
        return callback(null);
      }
      // Pull the original out of cloud storage to a temporary folder where
      // it can be cropped and popped back into uploadfs
      var originalFile = '/attachments/' + info._id + '-' + info.name + '.' + info.extension;
      var tempFile = self.uploadfs.getTempPath() + '/' + self.apos.utils.generateId() + '.' + info.extension;
      var croppedFile = '/attachments/' + info._id + '-' + info.name + '.' + crop.left + '.' + crop.top + '.' + crop.width + '.' + crop.height + '.' + info.extension;

      return async.series([
        function(callback) {
          self.uploadfs.copyOut(originalFile, tempFile, callback);
        },
        function(callback) {
          self.uploadfs.copyImageIn(tempFile, croppedFile, { crop: crop }, callback);
        },
        function(callback) {
          info.crops.push(crop);
          self.db.update({ _id: info._id }, info, callback);
        }
      ], function(err) {
        // We're done with the temp file. We don't care if it was never created.
        fs.unlink(tempFile, function() { });
        return callback(err);
      });
    });
  };

  self.sanitizeCrop = function(crop) {
    crop = _.pick(crop, 'top', 'left', 'width', 'height');
    crop.top = self.apos.launder.integer(crop.top, 0, 0, 10000);
    crop.left = self.apos.launder.integer(crop.left, 0, 0, 10000);
    crop.width = self.apos.launder.integer(crop.width, 1, 1, 10000);
    crop.height = self.apos.launder.integer(crop.height, 1, 1, 10000);
    if (_.keys(crop).length < 4) {
      return undefined;
    }
    return crop;
  };

  // Clones a file
  self.clone = function(req, source, callback) {
    var originalFile = '/attachments/' + source._id + '-' + source.name + '.' + source.extension;
    var tempFile = self.uploadfs.getTempPath() + '/' + self.apos.utils.generateId() + '.' + source.extension;

    var target = {
      _id: self.apos.utils.generateId(),
      length: source.length,
      group: source.group,
      createdAt: new Date(),
      name: source.name,
      title: source.title,
      extension: source.extension
    };

    var copyIn;
    var group = _.find(self.fileGroups, 'name', source.group)

    if (group && group.image) {
      // TODO add clone capability for crops of an image
      // target.crops = source.crops;
      // target.crop = source.crop;
      target.width = source.width;
      target.height = source.height;
      target.landscape = source.landscape;
      target.portrait = source.portrait;

      copyIn = self.uploadfs.copyImageIn;
    } else {
      copyIn = self.uploadfs.copyIn;
    }

    var targetPath = '/attachments/' + target._id + '-' + target.name + '.' + target.extension;

    return async.series([
      function(callback) {
        // Get the source, place in tempfile
        return self.uploadfs.copyOut(originalFile, tempFile, callback);
      },
      function(callback) {
        // Copy tempfile to target
        return copyIn(tempFile, '/attachments/' + target._id + '-' + target.name + '.' + target.extension, callback);
      },
      function(callback) {
        // Update meta for target
        return self.db.insert(target, callback);
      }
    ], function(err) {
      fs.unlink(tempFile, function() { });
      return callback(err, target);
    })
  };

  // This method return a default icon url if an attachment is missing
  // to avoid template errors

  self.getMissingAttachmentUrl = function() {
    var defaultIconUrl = '/modules/apostrophe-attachments/img/missing-icon.svg';
    console.error('Template warning: Impossible to retrieve the attachment url since it is missing, a default icon has been set. Please fix this ASAP!');
    return defaultIconUrl;
  };

  // This method is available as a template helper: apos.attachments.url
  //
  // Given an attachment object,
  // return the URL. If options.size is set, return the URL for
  // that size (one-third, one-half, two-thirds, full). full is
  // "full width" (1140px), not the original. For the original,
  // pass `original`. If size is not specified, you will receive
  // the `full` size if an image, otherwise the original.
  //
  // If the "uploadfsPath" option is true, an
  // uploadfs path is returned instead of a URL.

  self.url = function(attachment, options) {
    options = options || {};

    if (!attachment) {
      return self.getMissingAttachmentUrl();
    }

    var path = '/attachments/' + attachment._id + '-' + attachment.name;
    if (!options.uploadfsPath) {
      path = self.uploadfs.getUrl() + path;
    }
    // Attachments can have "one true crop," or a crop can be passed with the options.
    // For convenience, be tolerant if options.crop is passed but doesn't
    // actually have valid cropping properties
    var c;
    if (options.crop !== false) {
      c = options.crop || attachment._crop || attachment.crop;
      if (c && c.width) {
        path += '.' + c.left + '.' + c.top + '.' + c.width + '.' + c.height;
      }
    }
    var effectiveSize;
    if ((attachment.group !== 'images') || (options.size === 'original')) {
      effectiveSize = false;
    } else {
      effectiveSize = options.size || 'full';
    }
    if (effectiveSize) {
      path += '.' + effectiveSize;
    }
    return path + '.' + attachment.extension;
  };

  // This method is available as a template helper: apos.attachments.first
  //
  // Find the first attachment referenced within any object with
  // attachments as possible properties or sub-properties.
  //
  // For best performance be reasonably specific; don't pass an entire page or piece
  // object if you can pass page.thumbnail to avoid an exhaustive search, especially
  // if the page has many joins.
  //
  // Returns the first attachment matching the criteria.
  //
  // For ease of use, a null or undefined `within` argument is accepted.
  //
  // Examples:
  //
  // 1. In the body please
  //
  // apos.attachments.first(page.body)
  //
  // 2. Must be a PDF
  //
  // apos.attachments.first(page.body, { extension: 'pdf' })
  //
  // 3. May be any office-oriented file type
  //
  // apos.attachments.first(page.body, { group: 'office' })
  //
  // apos.images.first is a convenience wrapper for fetching only images.
  //
  // OPTIONS:
  //
  // You may specify `extension`, `extensions` (an array of extensions)
  // or `group` to filter the results.

  self.first = function(within, options) {
    options = options ? _.clone(options) : {};
    options.limit = 1;
    return self.all(within, options)[0];
  };

  // This method is available as a template helper: apos.attachments.all
  //
  // Find all attachments referenced within an object, whether they are
  // properties or sub-properties (via joins, etc).
  //
  // For best performance be reasonably specific; don't pass an entire page or piece
  // object if you can pass piece.thumbnail to avoid an exhaustive search, especially
  // if the piece has many joins.
  //
  // Returns an array of attachments, or an empty array if none are found.
  //
  // For ease of use, a null or undefined `within` argument is accepted.
  //
  // Examples:
  //
  // 1. In the body please
  //
  // apos.attachments.all(page.body)
  //
  // 2. Must be a PDF
  //
  // apos.attachments.all(page.body, { extension: 'pdf' })
  //
  // 3. May be any office-oriented file type
  //
  // apos.attachments.all(page.body, { group: 'office' })
  //
  // apos.images.all is a convenience wrapper for fetching only images.
  //
  // OPTIONS:
  //
  // You may specify `extension`, `extensions` (an array of extensions)
  // or `group` to filter the results.
  //
  // If `options.annotate` is true, a `._urls` property is added to all
  // image attachments wherever they are found in `within`, with
  // subproperties for each image size name, including `original`.
  // For non-images, a `._url` property is set.

  self.all = function(within, options) {
    options = options || {};

    function test(attachment) {
      if ((!attachment) || (typeof(attachment) !== 'object')) {
        return false;
      }
      if (attachment.type !== 'attachment') {
        return false;
      }
      if (options.extension) {
        if (attachment.extension !== options.extension) {
          return false;
        }
      }
      if (options.group) {
        if (attachment.group !== options.group) {
          return false;
        }
      }
      if (options.extensions) {
        if (!_.contains(options.extensions, attachment.extension)) {
          return false;
        }
      }
      return true;
    }

    var winners = [];
    if (!within) {
      return [];
    }
    self.apos.docs.walk(within, function(o, key, value, dotPath, ancestors) {
      if (test(value)) {
        // If one of our ancestors has a relationship to the piece that
        // immediately contains us, provide that as the crop. This ensures
        // that cropping coordinates stored in an apostrophe-images widget
        // are passed through when we make a simple call to
        // apos.attachments.url with the returned object
        var i;
        for (i = ancestors.length - 1; (i >= 0); i--) {
          var ancestor = ancestors[i];
          if (ancestor.relationships && ancestor.relationships[o._id]) {
            // Clone it so that if two things have crops of the same image, we
            // don't overwrite the value on subsequent calls
            value = _.clone(value);
            value._crop = _.pick(ancestor.relationships[o._id], 'top', 'left', 'width', 'height');
            value._focalPoint = _.pick(ancestor.relationships[o._id], 'x', 'y');
            break;
          }
        }
        if (options.annotate) {
          // Because it may have changed above due to cloning
          o[key] = value;
          // Add URLs
          value._urls = {};
          if (value.group === 'images') {
            _.each(self.imageSizes, function(size) {
              value._urls[size.name] = self.url(value, { size: size.name });
            });
            value._urls.original = self.url(value, { size: 'original' });
          } else {
            value._url = self.url(value);
          }
        }
        winners.push(value);
      }
    });
    return winners;
  };

  // Iterates over all of the attachments that exist, processing
  // up to `limit` attachments at any given time.
  //
  // If only 3 arguments are given the limit defaults to 1.
  //
  // For use only in command line tasks, migrations and other batch operations
  // in which permissions are a complete nonissue. NEVER use on the front end.

  self.each = function(criteria, limit, each, callback) {
    if (arguments.length === 3) {
      callback = each;
      each = limit;
      limit = 1;
    }

    // "Why do we fetch a bucket of attachments at a time?" File operations
    // can be very slow. This can lead to MongoDB cursor timeouts in
    // tasks like apostrophe-attachments:rescale. We need a robust solution that
    // does not require keeping a MongoDB cursor open too long. So we fetch
    // all of the IDs up front, then fetch buckets of "bucketSize" file objects
    // at a time and feed those through async.eachLimit. This is a
    // better compromise between RAM usage and reliability. -Tom

    var ids;
    var i = 0;
    var n = 0;
    var bucketSize = 100;
    return async.series({
      getIds: function(callback) {
        return self.db.find(criteria, { _id: 1 }).toArray(function(err, infos) {
          if (err) {
            return callback(err);
          }
          ids = _.pluck(infos, '_id');
          n = ids.length;
          return callback(null);
        });
      },
      processBuckets: function(callback) {
        return async.whilst(function() {
          return (i < n);
        }, function(callback) {
          var bucket = ids.slice(i, i + bucketSize);
          i += bucketSize;
          return self.db.find({ _id: { $in: bucket } }).toArray(function(err, files) {
            if (err) {
              return callback(err);
            }
            return async.eachLimit(files, limit, each, callback);
          });
        }, callback);
      }
    }, callback);
  };

  // Returns true if, based on the provided attachment object,
  // a valid focal point has been specified. Useful to avoid
  // the default of `background-position: center center` if
  // not desired.

  self.hasFocalPoint = function(attachment) {
    // No attachment object; tolerate for nunjucks friendliness
    if (!attachment) {
      return false;
    }
    // Specified directly on the attachment (it's not a join situation)
    if (typeof(attachment.x) === 'number') {
      return true;
    }
    // Specified on a `_focalPoint` property hoisted via a join
    return attachment._focalPoint && (typeof(attachment._focalPoint.x) === 'number');
  };

  // If a focal point is present on the attachment, convert it to
  // CSS syntax for `background-position`. No trailing `;` is returned.
  // The coordinates are in percentage terms.

  self.focalPointToBackgroundPosition = function(attachment) {
    if (!self.hasFocalPoint(attachment)) {
      return 'center center';
    }
    var point = self.getFocalPoint(attachment);
    return point.x + '% ' + point.y + '%';
  };

  // Returns an object with `x` and `y` properties containing the
  // focal point chosen by the user, as percentages. If there is no
  // focal point, null is returned.

  self.getFocalPoint = function(attachment) {
    if (!self.hasFocalPoint(attachment)) {
      return null;
    }
    var x = attachment._focalPoint ? attachment._focalPoint.x : attachment.x;
    var y = attachment._focalPoint ? attachment._focalPoint.y : attachment.y;
    return {
      x: x,
      y: y
    };
  };

  self.middleware = {
    canUpload: function(req, res, next) {
      if (!self.apos.permissions.can(req, 'edit-attachment')) {
        res.statusCode = 403;
        return res.send("forbidden");
      }
      next();
    }
  };

  self.addTypeMigration = function() {

    self.apos.migrations.add(self.__meta.name + '.addType', function(callback) {

      var needed;

      return async.series([ needed, attachments, docs ], callback);

      function needed(callback) {
        return self.db.findOne({ type: { $exists: 0 } }, function(err, found) {
          if (err) {
            return callback(err);
          }
          needed = !!found;
          return callback(null);
        });
      }

      function attachments(callback) {
        if (!needed) {
          return setImmediate(callback);
        }
        return self.db.update({}, { $set: { type: 'attachment' } }, { multi: true }, callback);
      }

      function docs(callback) {
        if (!needed) {
          return setImmediate(callback);
        }
        return self.apos.migrations.eachDoc({}, function(doc, callback) {
          var changed = false;
          self.apos.docs.walk(doc, function(o, key, value) {
            // Sniff out attachments in a database that predates the
            // type property for them
            if (value && (typeof(value) === 'object') && value.extension && value.md5 && value.group && value._id && value.group) {
              value.type = 'attachment';
              changed = true;
            }
          });
          if (!changed) {
            return setImmediate(callback);
          }
          self.apos.docs.db.update({ _id: doc._id }, doc, callback);
        }, callback);
      }
    }, {
      safe: true
    });

  };

  self.addDocReferencesMigration = function() {
    self.apos.migrations.add(self.__meta.name + '.docReferences', function(callback) {
      var needed;
      var attachmentUpdates = {};
      var parsed = 0;

      return async.series([ needed, docs, attachments, self.updatePermissions ], callback);

      function needed(callback) {
        return self.db.findOne({ docIds: { $exists: 0 } }, function(err, found) {
          if (err) {
            return callback(err);
          }
          needed = !!found;
          return callback(null);
        });
      }

      function docs(callback) {
        if (!needed) {
          return setImmediate(callback);
        }
        return self.apos.migrations.eachDoc({}, 5, addAttachmentUpdates, callback);
      }

      function addAttachmentUpdates(doc, callback) {
        var attachments = self.all(doc);
        var ids = _.uniq(_.pluck(attachments, '_id'));
        _.each(ids, function(id) {
          attachmentUpdates[id] = attachmentUpdates[id] || {
            $set: {
              docIds: [],
              trashDocIds: []
            }
          };
          if (doc.trash) {
            attachmentUpdates[id].$set.trashDocIds.push(doc._id);
          } else {
            attachmentUpdates[id].$set.docIds.push(doc._id);
          }
          attachmentUpdates[id].$set.utilized = true;
        });
        return setImmediate(callback);
      }

      function attachments(callback) {
        if (!needed) {
          return setImmediate(callback);
        }
        return async.series([ applyAttachmentUpdates, docIds, trashDocIds ], callback);
        function applyAttachmentUpdates(callback) {
          return async.eachLimit(_.keys(attachmentUpdates).slice(), 5, function(id, callback) {
            return self.db.update(
              {
                _id: id
              },
              attachmentUpdates[id],
              callback
            );
          }, callback);
        }
        function docIds(callback) {
          return self.db.update({
            docIds: { $exists: 0 }
          }, {
            $set: {
              docIds: []
            }
          }, {
            multi: true
          }, callback);
        }
        function trashDocIds(callback) {
          return self.db.update({
            trashDocIds: { $exists: 0 }
          }, {
            $set: {
              trashDocIds: []
            }
          }, {
            multi: true
          }, callback);
        }
      }

    }, {
      safe: true
    });

  };

  self.docAfterSave = function(req, doc, options, callback) {
    return self.updateDocReferences(doc, callback);
  };

  self.docAfterTrash = function(req, doc, callback) {
    return self.updateDocReferences(doc, callback);
  };

  self.docAfterRescue = function(req, doc, callback) {
    return self.updateDocReferences(doc, callback);
  };

  // When the last doc that contains this attachment goes to the
  // trash, its permissions should change to reflect that so
  // it is no longer web-accessible to those who know the URL.
  //
  // This method is invoked after any doc is inserted, updated, trashed
  // or rescued.

  self.updateDocReferences = function(doc, callback) {

    var attachments = self.all(doc);
    var ids = _.uniq(_.pluck(attachments, '_id'));

    // Build an array of mongo commands to run. Each
    // entry in the array is a 2-element array. Element 0
    // is the criteria, element 1 is the command

    var commands = [];

    if (!doc.trash) {
      commands.push([
        {
          _id: { $in: ids }
        },
        {
          $addToSet: { docIds: doc._id }
        }
      ],
      [
        {
          _id: { $in: ids }
        },
        {
          $pull: { trashDocIds: doc._id }
        }
      ]);
    } else {
      commands.push([
        {
          _id: { $in: ids }
        },
        {
          $addToSet: { trashDocIds: doc._id }
        }
      ],
      [
        {
          _id: { $in: ids }
        },
        {
          $pull: { docIds: doc._id }
        }
      ]);
    }

    commands.push([
      {
        $or: [
          {
            trashDocIds: { $in: [ doc._id ] }
          },
          {
            docIds: { $in: [ doc._id ] }
          }
        ],
        _id: { $nin: ids }
      },
      {
        $pull: {
          trashDocIds: doc._id,
          docIds: doc._id
        }
      }
    ], [
      {
        _id: { $in: ids }
      },
      {
        $set: {
          utilized: true
        }
      }
    ]);

    return async.series([
      updateCounts,
      self.updatePermissions
    ], callback);

    function updateCounts(callback) {
      return async.eachSeries(commands, function(command, callback) {
        return self.db.update(command[0], command[1], callback);
      }, callback);
    }
      
  };

  // Update the permissions in uploadfs of all attachments
  // based on whether the documents containing them
  // are in the trash or not. Specifically, if an attachment
  // has been utilized at least once but no longer has
  // any entries in `docIds` and `trash` is not yet true,
  // it becomes web-inaccessible, `utilized` is set to false
  // and `trash` is set to true. Similarly, if an attachment
  // has entries in `docIds` but `trash` is true,
  // it becomes web-accessible and trash becomes false.
  //
  // This method is invoked at the end of `updateDocReferences`
  // and also at the end of the migration that adds `docIds`
  // to legacy sites. You should not need to invoke it yourself.

  self.updatePermissions = function(callback) {

    return async.series([
      hide,
      show
    ], callback);

    function hide(callback) {
      return self.db.find({
        utilized: true,
        'docIds.0': { $exists: 0 },
        trash: { $ne: true }
      }).toArray(function(err, attachments) {
        if (err) {
          return callback(err);
        }
        return async.eachSeries(attachments, hideOne, callback);
      });
    }

    function show(callback) {
      return self.db.find({
        utilized: true,
        'docIds.0': { $exists: 1 },
        trash: { $ne: false }
      }).toArray(function(err, attachments) {
        if (err) {
          return callback(err);
        }
        return async.eachSeries(attachments, showOne, callback);
      });
    }

    function hideOne(attachment, callback) {
      return permissionsOne(attachment, true, callback);
    }

    function showOne(attachment, callback) {
      return permissionsOne(attachment, false, callback);
    }

    function permissionsOne(attachment, trash, callback) {

      var method = trash ? self.uploadfs.disable : self.uploadfs.enable;
      return async.series([
        original,
        crops,
        update
      ], callback);

      // Handle the original image and its scaled versions
      // here ("original" means "not cropped")
      function original(callback) {
        if ((!trash) && (attachment.trash === undefined)) {
          // Trash status not set at all yet means
          // it'll be a live file as of this point,
          // skip extra API calls
          return callback(null);
        }
        var sizes;
        if (!_.contains([ 'gif', 'jpg', 'png' ], attachment.extension)) {
          sizes = [ 'original' ];
        } else {
          sizes = self.imageSizes.concat([ 'original' ]);
        }
        return async.eachSeries(sizes, function(size) {
          if (size.name === self.sizeAvailableInTrash) {
            // This size is always kept accessible for preview
            // in the media library
            method = self.uploadfs.enable;
          }
          var path = self.url(attachment, { uploadfsPath: true, size: size.name });
          return method(path, function(err) {
            if (err) {
              // afterSave is not a good place for fatal errors
              console.warn('Unable to set permissions on ' + path + ', possibly it does not exist');
            }
            return callback(null);
          });
        }, callback);
      }

      function crops(callback) {
        if ((!trash) && (attachment.trash === undefined)) {
          // Trash status not set at all yet means
          // it'll be a live file as of this point,
          // skip extra API calls
          return callback(null);
        }
        return async.eachSeries(attachment.crops || [], cropOne, callback);
      }

      function cropOne(crop, callback) {
        return async.eachSeries(self.imageSizes.concat([ 'original' ]), function(size) {
          if (size.name === self.sizeAvailableInTrash) {
            // This size is always kept accessible for preview
            // in the media library
            method = self.uploadfs.enable;
          }
          var path = self.url(attachment, { crop: crop, uploadfsPath: true, size: size.name });
          return method(path, function(err) {
            if (err) {
              // afterSave is not a good place for fatal errors
              console.warn('Unable to set permissions on ' + path + ', possibly it does not exist');
            }
            return callback(null);
          });
        }, callback);
      }

      function update(callback) {
        return self.db.update({
          _id: attachment._id
        }, {
          $set: {
            trash: trash
          }
        }, callback);
      }
    }
  };

}
