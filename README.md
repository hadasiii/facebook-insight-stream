# facebook-insight-stream
FacebookInsightStream provide stream API, built over node-readable-stream, to read facebook insights
using the facebook Graph API V2.10.
Currently facebook insights api return data per metric, this module joins all the list
to one list by the insight date.

Currently support the following insights:

* [pages-insights]( https://developers.facebook.com/docs/graph-api/reference/v2.10/page/insights/ )
* [app-insights](https://developers.facebook.com/docs/graph-api/reference/v2.10/insights/)
* [audience-network](https://developers.facebook.com/docs/audience-network/reporting-api)

### Usage

```javascript
var FacebookInsightStream = require( "facebook-insight-stream" );

var options = {
    pastdays: "30",
    node: "page",
    token: "Replace with your facebook access token",
    period: "day",
    metrics: ["page_views"],
    itemList: ["replace with your facebook page id"],
}

var pageStream = new FacebookInsightStream( options )
    //  return list of insights  e.g [ { name: "mypage", views: "10" } ]
    .on( "data", console.log )
    // "oAuth error"
    .on( "error", console.log )
    // progress status  { total: "2", loaded: "1", message: "{{remaining}} pages remain"  }
    .on( "progress", console.log )
```

### FacebookInsightStream options:

* `pastdays` (string-required)#number of collected days from today e.g "30"
* `node` (string-required)#type of insight one of the two ( "app", "page" )
* `token` (string-required)#valid facebook oAuth token with 'read_insigt' scope
* `period` (string-required)#the time period to collect according to the relevant api
* `metrics` (array-required)#list of metrics to collect e.g [ "page_views", "unique_users" ]
* `itemList` (array-required)#list of pages/apps ids to collect from
* `events` (array)#list of events to collect from
* `aggregate` (bool)#value to set if it should aggregate by relevant types
* `breakdowns` (array)#list of breakdowns values to break results
