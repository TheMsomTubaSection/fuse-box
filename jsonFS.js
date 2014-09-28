/*
 * boxFS.js
 */
var f4js = require('fuse4js');
var fs = require('fs');
var path = require('path');
var open = require('open');
var tmp = require('tmp');
var Future = require('fibers/future'), wait = Future.wait;
var Fiber = require('fibers');
var box_sdk = require('box-sdk');
var options = {};  // See parseArgs()
var connection = null;


//---------------------------------------------------------------------------

/*
 * Given the name space represented by the object 'root', locate
 * the sub-object corresponding to the specified path
 */
function lookup(connection, path) {
	console.log(path);
	if (path === '/') {
		return { "type":"directory", "id":0, "name":'/' };
	}
	comps = path.split('/');
	var current = {};
	_backRecursePath(connection, path, current);
	return {'id':current.id, 'type':current.type, 'name':current.name};
}

function getEntry(id, item_collection) {
	for (x in item_collection) {
		if (id === x.id) {
			return x;
		}
	}
	return null;
}

function _backRecursePath(connection, currentPath, current) {
	var fiber = Fiber(function () {
		var future = new Future();
		if (currentPath === '/') {
			connection.getFolderInfo(0, function (error, body) {
				var json = eval(body);
				current = getEntry(json.item_collection.entries);
				future.return();
			});
		} else if (current !== null) {
			_backRecursePath(connection, path.resolve(path.join(currentPath, "..")), current);
			if (current.type === "folder") {
			connection.getFolderInfo(current.id, function (error, body) {
				var json = eval(body);
				current = getEntry(json.item_collection.entries);
				future.return();
			});
			} else {
			connection.getFileInfo(current.id, function (error, body) {
				var json = eval(body);
				current = getEntry(json.item_collection.entries);
				future.return();
			});
			}
				
		}
		future.wait();
	});
	fiber.run();
};

//---------------------------------------------------------------------------

/*
 * Handler for the getattr() system call.
 * path: the path to the file
 * cb: a callback of the form cb(err, stat), where err is the Posix return code
 *     and stat is the result in the form of a stat structure (when err === 0)
 */
function getattr(path, cb) {	
	var stat = {};
	var err = 0; // assume success
	var pathId = lookup(connection, path); // TODO lookup(connection, path) returns pathId = {id: file/folderId, type: "file/folder"}
connection.getFolderInfo(pathId.id, function (error, body) { // XYZZY FileInfo seems to be the same as FolderInfo? I dunooooooooooo
		if (error) return cb( error, null );
		var info = eval(body);
		stat.size = info.size;
		stat.mode = info.item_collection.total_count>1?"040":"010";
		if (info.shared_link != undefined) {
			stat.mode += (info.shared_link.permissions.can_share?0:0)+(info.shared_link.permissions.can_download?0:2)+(info.shared_link.permissions.can_upload?0:4)+((info.shared_link.permissions.can_share?0:0)+(info.shared_link.permissions.can_download?0:2)+(info.shared_link.permissions.can_upload?0:4)*10)+0((info.shared_link.permissions.can_share?0:0)+(info.shared_link.permissions.can_download?0:2)+(info.shared_link.permissions.can_upload?0:4)*10); // NOTE the execute bit is always set to false
		} else {
			stat.mode += "777";
		}
		stat.mode = parseInt(stat.mode);
		stat.mode = 040777;
		cb( err, stat);
		});
};

//---------------------------------------------------------------------------

/*
 * Handler for the readdir() system call.
 * path: the path to the file
 * cb: a callback of the form cb(err, names), where err is the Posix return code
 *     and names is the result in the form of an array of file names (when err === 0).
 */
function readdir(path, cb) {
	var names = [];//'Swift'];
	var err = 0; // assume success
	var pathId = lookup(connection, path); // TODO lookup(connection, path) returns pathId = {id: file/folderId, type: "file/folder"}

if (pathId.type === "file") {
	err = -2;
	cb( err, names );
} else {
	connection.getFolderInfo(pathId.id, function (error, body) {
			if (error) cb( error, null );
			var info = eval(body);
			console.log(JSON.stringify(body.item_collection.entries));
			for (i=0;i<body.item_collection.entries.length;i++) {
				names.push(body.item_collection.entries[i]);
				}
			cb(err, names);
			});
}
}

//---------------------------------------------------------------------------

/*
 * Handler for the open() system call.
 * path: the path to the file
 * flags: requested access flags as documented in open(2)
 * cb: a callback of the form cb(err, [fh]), where err is the Posix return code
 *     and fh is an optional numerical file handle, which is passed to subsequent
 *     read(), write(), and release() calls.
 */
function open(path, flags, cb) {
	var err = 0; // assume success
	var info = lookup(connection, path);

	if (info.type === 'undefined') {
		err = -2; // -ENOENT
	}
	cb(err); // we don't return a file handle, so fuse4js will initialize it to 0
}

//---------------------------------------------------------------------------

/*
 * Handler for the read() system call.
 * path: the path to the file
 * offset: the file offset to read from
 * len: the number of bytes to read
 * buf: the Buffer to write the data to
 * fh:  the optional file handle originally returned by open(), or 0 if it wasn't
 * cb: a callback of the form cb(err), where err is the Posix return code.
 *     A positive value represents the number of bytes actually read.
 */
function read(path, offset, len, buf, fh, cb) {
	var err = 0; // assume success
	var info = lookup(connection, path);
	var file = info.node;
	var maxBytes;
	var data;

	switch (file.type) {
		case 'undefined':
			err = -2; // -ENOENT
			break;

		case 'directory': // directory
			err = -1; // -EPERM
			break;

		case 'file': // a string treated as ASCII characters
			tmp.tmpName(function _tempNameGenerated(err, path) {
					if (err) cb(err);
					connection.getFile(file.id, null, path, function (error) {
							if (error) cb(error);
							fs.read(path, buf, 0, len, offset, cb);
							});
					});
			return;

		default:
			break;
	}
	cb(err);
}

//---------------------------------------------------------------------------

/*
 * Handler for the write() system call.
 * path: the path to the file
 * offset: the file offset to write to
 * len: the number of bytes to write
 * buf: the Buffer to read data from
 * fh:  the optional file handle originally returned by open(), or 0 if it wasn't
 * cb: a callback of the form cb(err), where err is the Posix return code.
 *     A positive value represents the number of bytes actually written.
 */
function write(path, offset, len, buf, fh, cb) {
	var err = 0; // assume success
	var file = lookup(connection, path);
	var parent = info.parent;
	var beginning, blank = '', data, ending='', numBlankChars;

	switch (file.type) {
		case 'undefined':
			err = -2; // -ENOENT
			break;

		case 'directory': // directory
			err = -1; // -EPERM
			break;

		case 'file': // a string treated as ASCII characters
			tmp.tmpName(function _tempNameGenerated(err, path) {
					if (err) cb(err);
					connection.getFile(file.id, null, path, function (error) {
							if (error) cb(error);
							fs.write(path, buf, 0, len, offset, function (error) {
									connection.uploadFileNewVersion(path, file.id, null, cb);
									});
							});
					});
			return;

		default:
			break;
	}
	cb(err);
}

//---------------------------------------------------------------------------

/*
 * Handler for the release() system call.
 * path: the path to the file
 * fh:  the optional file handle originally returned by open(), or 0 if it wasn't
 * cb: a callback of the form cb(err), where err is the Posix return code.
 */
function release(path, fh, cb) {
	cb(0);
}

//---------------------------------------------------------------------------

/*
 * Handler for the create() system call.
 * path: the path of the new file
 * mode: the desired permissions of the new file
 * cb: a callback of the form cb(err, [fh]), where err is the Posix return code
 *     and fh is an optional numerical file handle, which is passed to subsequent
 *     read(), write(), and release() calls (it's set to 0 if fh is unspecified)
 */
function create (path, mode, cb) {
	var err = 0; // assume success
	var info = lookup(connection, path);

	switch (info.type) {
		case 'undefined':
			tmp.tmpName(function _tempNameGenerated(err, path) {
					if (err) cb(err);
					connection.uploadFile(info.name, info.parent, cb);
					});
			break;

		case 'string': // existing file
		case 'object': // existing directory
			err = -17; // -EEXIST
			break;

		default:
			break;
	}
	cb(err);
}

//---------------------------------------------------------------------------

/*
 * Handler for the unlink() system call.
 * path: the path to the file
 * cb: a callback of the form cb(err), where err is the Posix return code.
 */
function unlink(path, cb) {
	var err = 0; // assume success
	var info = lookup(connection, path);

	switch (info.type) {
		case 'undefined':
			err = -2; // -ENOENT      
			break;

		case 'directory': // existing directory
			err = -1; // -EPERM
			break;

		case 'file': // existing file
			connection.deleteFileNewVersion(file.id, cb);
			return;

		default:
			break;
	}
	cb(err);
}

//---------------------------------------------------------------------------

/*
 * Handler for the rename() system call.
 * src: the path of the file or directory to rename
 * dst: the new path
 * cb: a callback of the form cb(err), where err is the Posix return code.
 */
function rename(src, dst, cb) {
	var err = -2; // -ENOENT assume failure
	var source = lookup(connection, src);

	if (source.type === 'file') { // existing file
		var dest = lookup(connection, dst);
		if (dest.type === 'undefined') {
			dest.parent = lookup(connection, path.resolve(dst+"/.."));
			connection.updateFile(source.id, {"name": dst, "id": dest.parent.id}, cb);
			err = 0;
		} else {
			err = -17; // -EEXIST
		}
	} else if (source.type === 'directory') { // existing file
		var dest = lookup(connection, dst);
		if (dest.type === 'undefined') {
			dest.parent = lookup(connection, path.resolve(dst+"/.."));
			connection.updateFolder(source.id, {"name": dst, "id": dest.parent.id}, cb);
			err = 0;
		} else {
			err = -17; // -EEXIST
		}
	}   
	cb(err);
}

//---------------------------------------------------------------------------

/*
 * Handler for the mkdir() system call.
 * path: the path of the new directory
 * mode: the desired permissions of the new directory
 * cb: a callback of the form cb(err), where err is the Posix return code.
 */
function mkdir(path, mode, cb) {
	var err = -2; // -ENOENT assume failure
	var dst = lookup(connection, path);
	if (typeof dst.node === 'undefined' && dst.parent != null) {
		dst.parent[dst.name] = {};
		err = 0;
	}
	cb(err);
}

//---------------------------------------------------------------------------

/*
 * Handler for the rmdir() system call.
 * path: the path of the directory to remove
 * cb: a callback of the form cb(err), where err is the Posix return code.
 */
function rmdir(path, cb) {
	var err = -2; // -ENOENT assume failure
	var dst = lookup(connection, path), dest;
	if (typeof dst.node === 'object' && dst.parent != null) {
		delete dst.parent[dst.name];
		err = 0;
	}
	cb(err);
}

//---------------------------------------------------------------------------

/*
 * Handler for the init() FUSE hook. You can initialize your file system here.
 * cb: a callback to call when you're done initializing. It takes no arguments.
 */
function init(cb) {
	console.log("File system started at " + options.mountPoint);
	console.log("To stop it, type this in another shell: fusermount -u " + options.mountPoint);
	cb();
}

//---------------------------------------------------------------------------

/*
 * Handler for the setxattr() FUSE hook. 
 * The arguments differ between different operating systems.
 * Darwin(Mac OSX):
 *  * a = position
 *  * b = options
 *  * c = cmd
 * Other:
 *  * a = flags
 *  * b = cmd
 *  * c = undefined
 */
function setxattr(path, name, value, size, a, b, c) {
	console.log("Setxattr called:", path, name, value, size, a, b, c)
		cb(0);
}

//---------------------------------------------------------------------------

/*
 * Handler for the statfs() FUSE hook. 
 * cb: a callback of the form cb(err, stat), where err is the Posix return code
 *     and stat is the result in the form of a statvfs structure (when err === 0)
 */
function statfs(cb) {
	cb(0, {
bsize: 1000000,
frsize: 1000000,
blocks: 1000000,
bfree: 1000000,
bavail: 1000000,
files: 1000000,
ffree: 1000000,
favail: 1000000,
fsid: 1000000,
flag: 1000000,
namemax: 1000000
});
}

//---------------------------------------------------------------------------

/*
 * Handler for the destroy() FUSE hook. You can perform clean up tasks here.
 * cb: a callback to call when you're done. It takes no arguments.
 */
function destroy(cb) {
	if (options.outJson) {
		try {
			fs.writeFileSync(options.outJson, JSON.stringify(connection, null, '  '), 'utf8');
		} catch (e) {
			console.log("Exception when writing file: " + e);
		}
	}
	console.log("File system stopped");      
	cb();
}

//---------------------------------------------------------------------------

var handlers = {
getattr: getattr,
	 readdir: readdir,
	 open: open,
	 read: read,
	 write: write,
	 release: release,
	 create: create,
	 unlink: unlink,
	 rename: rename,
	 mkdir: mkdir,
	 rmdir: rmdir,
	 init: init,
	 destroy: destroy,
	 setxattr: setxattr,
	 statfs: statfs
};

//---------------------------------------------------------------------------

function usage() {
	console.log();
	console.log("Usage: node jsonFS.js [options] inputJsonFile mountPoint");
	console.log("(Ensure the mount point is empty and you have wrx permissions to it)\n")
		console.log("Options:");
	console.log("-o outputJsonFile  : save modified data to new JSON file. Input file is never modified.");
	console.log("-d                 : make FUSE print debug statements.");
	console.log("-a                 : add allow_other option to mount (might need user_allow_other in system fuse config file).");
	console.log();
	console.log("Example:");
	console.log("node example/jsonFS.fs -d -o /tmp/output.json example/sample.json /tmp/mnt");
	console.log();
}

//---------------------------------------------------------------------------

function parseArgs() {
	var args = process.argv;
	if (args.length < 3) {
		return false;
	}
	options.mountPoint = args[2];
	options.email = args[3];
	return true;
}

//---------------------------------------------------------------------------

(function main() {
 if (parseArgs()) {
 console.log("Mount point: " + options.mountPoint);
 var box = box_sdk.Box({
client_id: 'ja3zdy0zyo49t60iuko1ix7h2w7ikl73',
client_secret: 'oqBXCS7lQgSDRBNySVymWHjAyO4BkEiU',
port: 5000,
host: 'localhost' //default localhost
}, 1);
 connection = box.getConnection(options.email);

 //Navigate user to the auth URL
open(connection.getAuthURL());

 connection.ready(function () {
	 try {
	 f4js.start(options.mountPoint, handlers, options.debugFuse, []);
	 } catch (e) {
	 console.log("Exception when starting file system: " + e);
	 }});
 } else {
	 usage();
 }
})();
