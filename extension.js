// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
const vscode = require('vscode');
const WebSocket = require('ws');
const tiny = require('tiny-json-http')

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed

/**
 * @param {vscode.ExtensionContext} context
 */

 var ws_ = null;
 let connected_ = false;
 let sentPassword_ = false;
 let termOpen_ = false;
 const writeEmitter = new vscode.EventEmitter();
 function sleep (time) {
	return new Promise((resolve) => setTimeout(resolve, time));
  }

function activate(context) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "webrepl-terminal" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with  registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('webrepl-terminal.sync', async function () {
		let config = vscode.workspace.getConfiguration('webrepl-terminal');

		if (!vscode.workspace.workspaceFolders) {
			return vscode.window.showInformationMessage('No folder or workspace opened');
		}
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "I am long running!",
			cancellable: true
		}, async (progress, token) => {
			let canceled = false;
			let completed = false;
			token.onCancellationRequested(() => {
				canceled = true;
				console.log("User canceled the long running operation");
			});
			progress.report({ increment: 0 });

			function syncFolder(parentPath, folderUri, folderName) {
				if(canceled){
					return;
				}
				const subfolderUri = folderUri.with({ path: folderUri.path + "/" + folderName });
				let filePaths = [];
				let promises = [];
				vscode.workspace.fs.readDirectory(subfolderUri).then((projectFolders) => {
					for(var i = 0; i < projectFolders.length; i++){
						var fileObject = projectFolders[i];
						if (fileObject[1] === vscode.FileType.File) {
							progress.report({ increment: 0, message: "uploading " + fileObject[0]});
							const filePath = subfolderUri.path + "/" + fileObject[0];
							filePaths.push(filePath);
							const fileUri = subfolderUri.with({path: filePath})
							promises.push(vscode.workspace.fs.readFile(fileUri));
						}else{
							promises.concat(syncFolder(parentPath, subfolderUri, fileObject[0]));
						}
					};
					return promises;
				}).then(() => {
					return Promise.all(promises);
				}).then((readDatas) => {
					for(var i = 0; i < readDatas.length; i++){
						var readData = readDatas[i];
						var filePath = filePaths[i];
						let shortName = filePath.replace(parentPath, "");

						let url = config.get('url');
						let stringData = readData.toJSON();
						tiny.post({'url':url, data:{'filename': shortName, 'data': stringData}}, (err, result) => {
							if (err) {
								console.log('ruh roh!', err)
							}
							else {
								console.log(result)
							}
						})
					}
				})
			}

			return new Promise(async (resolve) =>{

				let folderUri = vscode.workspace.workspaceFolders[0].uri;
				let projectFolders = await vscode.workspace.fs.readDirectory(folderUri);

				projectFolders.forEach(async (folder) => {
					if(folder[0] === config.get("syncFolder")){
						await syncFolder(folderUri.path + '/' + folder[0], folderUri, folder[0]);
					}
				})
				resolve();
			})
		});
	});

	context.subscriptions.push(disposable);

	context.subscriptions.push(vscode.commands.registerCommand('webrepl-terminal.create', () => {

		const pty = {
			onDidWrite: writeEmitter.event,
			open: () => {
				termOpen_ = true;
			},
			close: () => { 
				termOpen_ = false;
				if(connected_){
					ws_.close();
					connected_ = false;
				}
				ws_ = null;
			 },
			handleInput: (data) => {
				data = data.replace(/\n/g, "\r");
				ws_.send(data);
				console.debug(data);
			}
		};

		const terminal = (vscode.window).createTerminal({ name: `My Extension REPL`, pty });
		terminal.show();
		setInterval(()=>{
			if(!connected_ && termOpen_){
				try{
					connect();
				}catch (error){
					writeEmitter.fire('connect failed ' + error.toString());
				}
			}
		}, 2000)
	}));
}

function connect(){
	let config = vscode.workspace.getConfiguration('webrepl-terminal');
	let url = config.get('wsUrl');
	ws_ = new WebSocket(url);
	ws_.binaryType = 'arraybuffer';
	// this is for file uploading, which is done in chunks
	var put_file_name = "";
	var put_file_data;
	ws_.binary_state = 0;

	ws_.onopen = function() {
		connected_ = true;
		sentPassword_ = false;
		writeEmitter.fire('\x1b[31mConnected to ' + url+ '\x1b[m\r\n');
		ws_.onmessage = function(event) {
			if (event.data instanceof ArrayBuffer) {
				var data = new Uint8Array(event.data);
				switch (ws_.binary_state) {
					case 11:
						// first response for put
						if (decode_resp(data) == 0) {
							// send file data in chunks
							for (var offset = 0; offset < put_file_data.length; offset += 1024) {
								ws_.send(put_file_data.slice(offset, offset + 1024));
							}
							ws_.binary_state = 12;
						}
						break;
					case 12:
						// final response for put
						if (decode_resp(data) == 0) {
							writeEmitter.fire('Sent ' + put_file_name + ', ' + put_file_data.length + ' bytes');
						} else {
							writeEmitter.fire('Failed sending ' + put_file_name);
						}
						ws_.binary_state = 0;
						break;

					case 21:
						// first response for get
						if (decode_resp(data) == 0) {
							ws_.binary_state = 22;
							var rec = new Uint8Array(1);
							rec[0] = 0;
							ws_.send(rec);
						}
						break;
					case 22: {
						// file data
						var sz = data[0] | (data[1] << 8);
						if (data.length == 2 + sz) {
							// we assume that the data comes in single chunks
							if (sz == 0) {
								// end of file
								ws_.binary_state = 23;
							} else {
								// accumulate incoming data to get_file_data
								var new_buf = new Uint8Array(get_file_data.length + sz);
								new_buf.set(get_file_data);
								new_buf.set(data.slice(2), get_file_data.length);
								get_file_data = new_buf;
								writeEmitter.fire('Getting ' + get_file_name + ', ' + get_file_data.length + ' bytes');

								var rec = new Uint8Array(1);
								rec[0] = 0;
								ws_.send(rec);
							}
						} else {
							ws_.binary_state = 0;
						}
						break;
					}
					case 23:
						// final response
						if (decode_resp(data) == 0) {
							writeEmitter.fire('Got ' + get_file_name + ', ' + get_file_data.length + ' bytes');
							saveAs(new Blob([get_file_data], {type: "application/octet-stream"}), get_file_name);
						} else {
							writeEmitter.fire('Failed getting ' + get_file_name);
						}
						ws_.binary_state = 0;
						break;
					case 31:
						// first (and last) response for GET_VER
						console.log('GET_VER', data);
						ws_.binary_state = 0;
						break;
				}
			}
			writeEmitter.fire(event.data);
			if(!sentPassword_){
				let password = config.get("password");
				for (var i = 0; i < password.length; i++) {
					ws_.send(password.charAt(i));
					//writeEmitter.fire(password.charAt(i));
					}
				ws_.send('\n');
				writeEmitter.fire('\n');
				sentPassword_ = true;
			}
		};
	};

	ws_.onclose = function() {
		writeEmitter.fire('\x1b[31mDisconnected\x1b[m\r\n');
	}

	ws_.putFile = function (pfn, pfd) {
		put_file_name = pfn;
		put_file_data = pfd;
		var dest_fname = put_file_name;
		var dest_fsize = put_file_data.length;
	
		// WEBREPL_FILE = "<2sBBQLH64s"
		var rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
		rec[0] = 'W'.charCodeAt(0);
		rec[1] = 'A'.charCodeAt(0);
		rec[2] = 1; // put
		rec[3] = 0;
		rec[4] = 0; rec[5] = 0; rec[6] = 0; rec[7] = 0; rec[8] = 0; rec[9] = 0; rec[10] = 0; rec[11] = 0;
		rec[12] = dest_fsize & 0xff; rec[13] = (dest_fsize >> 8) & 0xff; rec[14] = (dest_fsize >> 16) & 0xff; rec[15] = (dest_fsize >> 24) & 0xff;
		rec[16] = dest_fname.length & 0xff; rec[17] = (dest_fname.length >> 8) & 0xff;
		for (var i = 0; i < 64; ++i) {
			if (i < dest_fname.length) {
				rec[18 + i] = dest_fname.charCodeAt(i);
			} else {
				rec[18 + i] = 0;
			}
		}
	
		// initiate put
		ws_.binary_state = 11;
		writeEmitter.fire('Sending ' + put_file_name + '...');
		ws_.send(rec);
	}
	ws_.get_ver = function() {
		// WEBREPL_REQ_S = "<2sBBQLH64s"
		var rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
		rec[0] = 'W'.charCodeAt(0);
		rec[1] = 'A'.charCodeAt(0);
		rec[2] = 3; // GET_VER
		// rest of "rec" is zero
	
		// initiate GET_VER
		binary_state = 31;
		ws_.send(rec);
	}
	
}


function colorText(text) {
	let output = '';
	let colorIndex = 1;
	for (let i = 0; i < text.length; i++) {
		const char = text.charAt(i);
		if (char === ' ' || char === '\r' || char === '\n') {
			output += char;
		} else {
			output += `\x1b[3${colorIndex++}m${text.charAt(i)}\x1b[0m`;
			if (colorIndex > 6) {
				colorIndex = 1;
			}
		}
	}
	return output;
}


function decode_resp(data) {
    if (data[0] == 'W'.charCodeAt(0) && data[1] == 'B'.charCodeAt(0)) {
        var code = data[2] | (data[3] << 8);
        return code;
    } else {
        return -1;
    }
}



function get_file() {
    var src_fname = document.getElementById('get_filename').value;

    // WEBREPL_FILE = "<2sBBQLH64s"
    var rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
    rec[0] = 'W'.charCodeAt(0);
    rec[1] = 'A'.charCodeAt(0);
    rec[2] = 2; // get
    rec[3] = 0;
    rec[4] = 0; rec[5] = 0; rec[6] = 0; rec[7] = 0; rec[8] = 0; rec[9] = 0; rec[10] = 0; rec[11] = 0;
    rec[12] = 0; rec[13] = 0; rec[14] = 0; rec[15] = 0;
    rec[16] = src_fname.length & 0xff; rec[17] = (src_fname.length >> 8) & 0xff;
    for (var i = 0; i < 64; ++i) {
        if (i < src_fname.length) {
            rec[18 + i] = src_fname.charCodeAt(i);
        } else {
            rec[18 + i] = 0;
        }
    }

    // initiate get
    binary_state = 21;
    get_file_name = src_fname;
    get_file_data = new Uint8Array(0);
    writeEmitter.fire('Getting ' + get_file_name + '...');
    ws.send(rec);
}


// this method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
