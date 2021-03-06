// doc: this module is a facebook-insights read stream built over node readable stream
// it provide stream api to read insights data from facebook accounts,
// currently supporting only pages-insight, posts-insights and app-insights.

module.exports = FacebookInsightStream;

var util = require( "util" );
var sugar = require( "sugar" );
var stream = require( "stream" );
var extend = require( "extend" );
var request = require( "request" );
var Promise = require( "bluebird" );

request = Promise.promisifyAll( request )

var BASEURL = "https://graph.facebook.com/v2.10";
// Missing data is flagged by the error code 100
// GraphMethodException error:
// Object with ID 'some_id' does not exist,
// cannot be loaded due to missing permissions,
// or does not support this operation
var MISSING_ERROR_CODE = 100;
var NOT_SUPPORTED_CODE = 3001;

//edge url for each node type
var EDGEMAP = {
    page: "insights",
    app: "app_insights",
    post: "insights"
}

util.inherits( FacebookInsightStream, stream.Readable )
function FacebookInsightStream( options ) {
    stream.Readable.call( this, { objectMode: true } );
    var listItems = options.itemList;
    var isFunction = typeof listItems === 'function';
    if ( !isFunction ) {
        listItems = function () { return options.itemList }
    }

    options.listItems = listItems
    options.edge = EDGEMAP[ options.node ];
    this.options = options;
}

// _read will be called once for each collected item
FacebookInsightStream.prototype._read = function ( ) {

    if ( ! this.items ) {
        return this._init( this._read.bind( this ) )
            .catch( this.emit.bind( this, 'error') )
    }
    if ( ! this.items.length ) {
        return this.push( null )
    }
    var metrics = this.options.metrics.clone();
    var item = this.items[ this.items.length - 1 ];
    var events = this.events.clone();

    this._collect( metrics, item, {}, events )
        .tap( this.removeItem.bind( this ) )
        .then( this._handleData.bind( this ) )
}

FacebookInsightStream.prototype.removeItem = function () {
    var idx = this.items.indexOf( this.item );
    this.items.splice( idx, 1 );
}

FacebookInsightStream.prototype._handleData = function ( data ) {
    return this.push( data )
}

FacebookInsightStream.prototype._init = function ( callback ) {
    var options = this.options;

    // building url pattern for all the request
    var until = Date.now();
    var since = new Date();
    since = since.setDate( since.getDate() - options.pastdays )

    // fb ask for timestamp in seconds
    until = Math.round( until / 1000 );
    since = Math.round( since / 1000 );

    var path = [
        BASEURL,
        "{id}",
        options.edge,
        "{metric}",
    ].join( "/" )

    var query = [
        "access_token=" + options.token,
        "period=" + options.period,
        "since=" + since,
        "until=" + until,
    ].join( "&" );

    var hasEvents = options.events && options.events.length;
    var breakdowns = options.breakdowns;

    if ( hasEvents ) {
        query += "&event_name={ev}"
    }

    if ( options.aggregate ) {
        query += "&aggregateBy={agg}";
    }

    if ( breakdowns && breakdowns.length ) {
        for ( var i = 0; i < breakdowns.length; i += 1 ) {
            query += "&breakdowns[{index}]={breakdown}".assign( {
                index: i,
                breakdown: breakdowns[ i ]
            });
        }
    }

    // this url is urlPattern shared by all the requests
    // each request using thie pattern should replace the
    // {id} and {metric} place holders with real values
    this.url = [ path, query ].join( "?" )

    // options.itemlist is a function that can return either array of items or
    // or a promise that resolved with array of items
    var itemList = options.listItems();
    return Promise.resolve( itemList )
        .bind( this )
        .map( this._initItem, { concurrency: 3 } )
        // Calling _initItem on each object might have resulted in some
        // skipped objects. These will still have been returned in the mapped
        // array as `undefined` elements. This filter removes them.
        .filter(Boolean)
        .then( function ( items ) {
            this.items = items;
            this.events = options.events || [];
            this.total = items.length;
            this.loaded = 0;
            return callback();
        })
        .catch( function ( error ) {
            var retry = this._init.bind( this, callback );
            return this.handleError( error, retry )
        })
}

FacebookInsightStream.prototype._initItem = function ( item ) {
    var options = this.options;
    var model = {
        base: BASEURL,
        id: item,
        token: options.token
    };

    var url = strReplace( "{base}/{id}?access_token={token}", model )

    var title = "FACEBOOK " + options.node.toUpperCase();
    console.log( new Date().toISOString(), title, url )

    return request.getAsync( url )
        .bind( this )
        .get( 1 )
        .then( JSON.parse )
        .then( errorHandler.bind( null, options ) )
        .then( function ( data ) {
            var result = {
                id: item,
                name: data.name || data.message || data.story
            }
            if ( options.node === 'post' ) {
                result.createdTime  = data.created_time
            }
            return result
        })
        .catch( SkippedError, function ( error ) {
            console.warn( "facebook-insights skipped error", error );
        })
        .catch( function ( error ) {
            var retry = this._initItem.bind( this, item );
            return this.handleError( error, retry )
        })
}

// _collect will be called once for each metric, the insight api request
// single api call for each metric, wich result in a list of values ( value per day)
// so in attempt to create one table with all the metrics,
// we are buffering each result in a key value map, with key for
// each day in the collected time range, and appending each value
// of the current metric to the appropriate key in the buffer.
// finally we generating single row for each day.

FacebookInsightStream.prototype._collect = function ( metrics, item, buffer, events ) {
    var options = this.options;
    var hasEvents = events && events.length;
    // done with the current item
    if ( ! metrics.length && ! hasEvents ) {
        var data = Object.keys( buffer ).map( function ( key ) {
            var row = buffer[ key ];

            // if the key is constructed with numerous attributes,
            // take the datetime information
            row.date = key.split( "__" )[ 0 ];
            row[ options.node + "Id" ] = item.id;
            row[ options.node + "Name" ] = item.name;
            // set created_time for posts
            if ( options.node === 'post' ) {
                row[ 'created_time' ] = item.createdTime;
            }
            return row;
        })

        this.emit( "progress", {
            total: this.total,
            loaded: ++this.loaded,
            message: "{{remaining}} " + options.node + "s remaining"
        })
        return data;
    }

    // for the audience API, we just use one metric ['app_event']
    // with a few events
    var _metric = metrics[ metrics.length -1 ] || options.metrics[ 0 ];
    var model = { id: item.id, metric: _metric }

    var _ev;
    var _agg;
    if ( hasEvents ) {
        // extend the query model with event name
        // and aggregation type
        _ev = events[ events.length - 1 ];
        _agg = aggregationType( _ev );

        extend( model, { ev: _ev, agg: _agg } );
    }

    var url = strReplace( this.url, model );
    var title = "FACEBOOK " + options.node.toUpperCase();

    console.log( new Date().toISOString(), title, url );

    return request.getAsync( url )
        .get( 1 )
        .then( JSON.parse )
        .then( errorHandler.bind( null, options ) )
        .get( "data" )
        .bind( this )
        .then( function ( data ) {
            // in case that there is no data for a given metric
            // we will skip to the next metric
            if ( ! data.length ) {
                var error = new Error( "No data found for the metric " + _metric );
                error.skip = true;
                throw error;
            }
            // in app insight the returned data is list of values
            // in page insight its object that include the list of values
            return data[ 0 ].values || data
        })
        .each( function ( val ) {
            var key = val.end_time || val.time || 'lifetime';
            // when using breakdowns we get numerous results for
            // the same date therefore we need to identify unique
            // keys for the buffer by the date and different breakdowns
            // we're using the '__' to later seperate the date
            Object.keys( val.breakdowns || {} ).forEach( function ( b ){
                key += "__{breakdown}".assign( {
                    breakdown: val.breakdowns[ b ]
                });
            });

            buffer[ key ] || ( buffer[ key ] = {} )
            // either a metric or an event
            var column = _ev ? _ev : _metric;
            if ( typeof val.value === 'object' ) {
                Object.keys( val.value ).map( function ( subMetric ) {
                    var col = column + '_' + subMetric;
                    buffer[ key ][ col ] = val.value[subMetric];
                })
            } else {
                buffer[ key ][ column ] = val.value || null;
            }

            // set breakdowns data if given
            var breakdowns = options.breakdowns;
            if ( !breakdowns || !val.breakdowns ) {
                return;
            }

            for ( var i = 0; i < breakdowns.length; i += 1 ) {
                // options breakdown
                var b = breakdowns[ i ];

                if ( val.breakdowns[ b ] ) {
                    buffer[ key ][ b ] = val.breakdowns[ b ];
                }
            }
        })
        .catch( SkippedError, function ( error ) {
            console.warn( "facebook-insights skipped error", error );
        })
        .then( function () {
            // remove the current paramater when done
            var _metricIdx = metrics.indexOf( _metric );
            var _evIdx = events.indexOf( _ev );
            metrics.splice( _metricIdx, 1 );
            events.splice( _evIdx, 1 );

            return this._collect( metrics, item, buffer, events );
        })
        .catch( function ( error ) {
            var retry = this._collect.bind( this, metrics, item, buffer, events );
            return this.handleError( error, retry );
        })
}

/**
 * Thrown error handling methos, when any part of the stream throws an error
 * it pass its error to this method, with retry function and the thrown error
 * this function decides if this error is retryable, and then retry the method
 * that generated the error by calling to retry, otherwise it emmits error.
 *
 * Overide this method to create your own error handling and retrying mechanism
 *
 * @param  {Error}  error
 * @param  {Function} retry the function that should be invoke to retry the process
 */
FacebookInsightStream.prototype.handleError = function ( error, retry ) {
    if ( error.retry === true ) {
        return retry();
    } else {
        this.emit( 'error', error );
    }
}

// predicate-based error filter
function SkippedError ( error ) {
    return error.skip === true;
}

function errorHandler ( options, body )  {
    if ( body.error ) {
        var missingItem = body.error.code === MISSING_ERROR_CODE
        body.error.skip = (options.ignoreMissing && missingItem)
            || body.error.code === NOT_SUPPORTED_CODE

        throw body.error
    } else {
        return body
    }
}

function strReplace ( string, model ) {
    Object.keys( model ).each( function ( name ) {
        string = string.replace( "{" + name + "}", model[ name ] );
    })

    return string;
}

function aggregationType ( ev ) {
    var events = [ "fb_ad_network_imp", "fb_ad_network_click" ];

    var shouldUseCount = ev && events.indexOf( ev ) > -1;
    if ( shouldUseCount ) {
        return "COUNT"
    }

    return "SUM";
}
