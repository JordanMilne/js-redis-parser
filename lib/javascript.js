'use strict';

var _bufToStr = function(buf) {
	return String.fromCharCode.apply(null, buf);
};

var _concatBuffer = function(buffer1, buffer2) {
  var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp;
};

var _concatBuffers = function(bufferList) {
	var lastBuf = bufferList[0];
	for (var i = 1; i < bufferList.length; ++i) {
		// The stupid and naive way.
		lastBuf = _concatBuffer(lastBuf, bufferList[i]);
	}
	return lastBuf;
};

function JavascriptReplyParser(options) {
    this.name = 'javascript';
    this.buffer = new Uint8Array(0);
    this.offset = 0;
    this.bigStrSize = 0;
    this.chunksSize = 0;
    this.buffers = [];
    this.type = 0;
    this.protocolError = false;
    this.offsetCache = 0;
    // If returnBuffers is active, all return values are returned as buffers besides numbers and errors
    if (options.return_buffers) {
        this.handleReply = function (start, end) {
            return this.buffer.slice(start, end);
        };
    } else {
        this.handleReply = function (start, end) {
            return _bufToStr(this.buffer.slice(start, end));
        };
    }
    // If stringNumbers is activated the parser always returns numbers as string
    // This is important for big numbers (number > Math.pow(2, 53)) as js numbers are 64bit floating point numbers with reduced precision
    if (options.string_numbers) {
        this.handleNumbers = function (start, end) {
            return _bufToStr(this.buffer.slice(start, end));
        };
    } else {
        this.handleNumbers = function (start, end) {
            return +(_bufToStr(this.buffer.slice(start, end)));
        };
    }
}

JavascriptReplyParser.prototype.parseResult = function (type) {
    var start = 0,
        end = 0,
        packetHeader = 0,
        reply;

    if (type === 36) { // $
        packetHeader = this.parseHeader();
        // Packets with a size of -1 are considered null
        if (packetHeader === -1) {
            return null;
        }
        end = this.offset + packetHeader;
        start = this.offset;
        if (end + 2 > this.buffer.byteLength) {
            this.buffers.push(this.offsetCache === 0 ? this.buffer : this.buffer.slice(this.offsetCache));
            this.chunksSize = this.buffers[0].byteLength;
            // Include the packetHeader delimiter
            this.bigStrSize = packetHeader + 2;
            throw new Error('Wait for more data.');
        }
        // Set the offset to after the delimiter
        this.offset = end + 2;
        return this.handleReply(start, end);
    } else if (type === 58) { // :
        // Up to the delimiter
        end = this.packetEndOffset();
        start = this.offset;
        // Include the delimiter
        this.offset = end + 2;
        // Return the coerced numeric value
        return this.handleNumbers(start, end);
    } else if (type === 43) { // +
        end = this.packetEndOffset();
        start = this.offset;
        this.offset = end + 2;
        return this.handleReply(start, end);
    } else if (type === 42) { // *
        packetHeader = this.parseHeader();
        if (packetHeader === -1) {
            return null;
        }
        reply = [];
        for (var i = 0; i < packetHeader; i++) {
            if (this.offset >= this.buffer.byteLength) {
                throw new Error('Wait for more data.');
            }
            reply.push(this.parseResult(this.buffer[this.offset++]));
        }
        return reply;
    } else if (type === 45) { // -
        end = this.packetEndOffset();
        start = this.offset;
        this.offset = end + 2;
        return new Error(_bufToStr(this.buffer.slice(start, end)));
    }
};

JavascriptReplyParser.prototype.execute = function (buffer) {
    if (this.chunksSize !== 0) {
        if (this.bigStrSize > this.chunksSize + buffer.byteLength) {
            this.buffers.push(buffer);
            this.chunksSize += buffer.byteLength;
            return;
        }
        this.buffers.push(buffer);
        this.buffer = _concatBuffers(this.buffers);
        this.buffers = [];
        this.bigStrSize = 0;
        this.chunksSize = 0;
    } else if (this.offset >= this.buffer.byteLength) {
        this.buffer = buffer;
    } else {
        this.buffer = _concatBuffer(this.buffer.slice(this.offset), buffer);
    }
    this.offset = 0;
    this.run();
};

JavascriptReplyParser.prototype.tryParsing = function () {
    try {
        return this.parseResult(this.type);
    } catch (err) {
        // Catch the error (not enough data), rewind if it's an array,
        // and wait for the next packet to appear
        this.offset = this.offsetCache;
        // Indicate that there's no protocol error by resetting the type too
        this.type = undefined;
    }
};

JavascriptReplyParser.prototype.run = function () {
    // Set a rewind point. If a failure occurs, wait for the next execute()/append() and try again
    this.offsetCache = this.offset;
    this.type = this.buffer[this.offset++];
    var reply = this.tryParsing();

    while (reply !== undefined) {
        if (this.type === 45) { // Errors -
            this.returnError(reply);
        } else {
            this.returnReply(reply); // Strings + // Integers : // Bulk strings $ // Arrays *
        }
        this.offsetCache = this.offset;
        this.type = this.buffer[this.offset++];
        reply = this.tryParsing();
    }
    if (this.type !== undefined) {
        // Reset the buffer so the parser can handle following commands properly
        this.buffer = new Uint8Array(0);
        this.returnFatalError(new Error('Protocol error, got ' + JSON.stringify(String.fromCharCode(this.type)) + ' as reply type byte'));
    }
};

JavascriptReplyParser.prototype.parseHeader = function () {
    var end   = this.packetEndOffset(),
        value = _bufToStr(this.buffer.slice(this.offset, end)) | 0;

    this.offset = end + 2;
    return value;
};

JavascriptReplyParser.prototype.packetEndOffset = function () {
    var offset = this.offset,
        len = this.buffer.byteLength - 1;

    while (this.buffer[offset] !== 0x0d && this.buffer[offset + 1] !== 0x0a) {
        offset++;

        if (offset >= len) {
            throw new Error('Did not see LF after NL reading multi bulk count (' + offset + ' => ' + this.buffer.byteLength + ', ' + this.offset + ')');
        }
    }
    return offset;
};

module.exports = JavascriptReplyParser;
