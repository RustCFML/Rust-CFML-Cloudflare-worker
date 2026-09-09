<cfscript>
    request.pageTitle = "cfhttp test bench";
    // Deliberately no activeNav: this page is unlisted. It sends live requests
    // to whatever URL is typed into it, so it stays off the navigation.

    // Default target. requesthook.com issues a per-endpoint URL, so paste
    // yours in; the page keeps whatever you last submitted.
    param name="form.target"   type="string"  default="https://requesthook.com/";
    param name="form.mode"     type="string"  default="";
    param name="form.headers"  type="string"  default="X-Sent-From: rustcfml-worker";
    param name="form.body"     type="string"  default='{ "hello": "from the edge" }';
    param name="form.qs"       type="string"  default="source=worker&note=hello world";
    param name="form.filename" type="string"  default="report.csv";
    param name="form.mimetype" type="string"  default="text/csv";
    param name="form.filebody" type="string"  default="region,value#chr(10)#EMEA,4200#chr(10)#AMER,8800";
    param name="form.field"    type="string"  default="note";
    param name="form.fieldval" type="string"  default="uploaded from a Cloudflare Worker";

    result   = {};
    sent     = "";
    threw    = "";
    elapsed  = 0;

    // Headers are entered one per line as "Name: value".
    function parseHeaders( required string raw ) {
        var out = [];
        for ( var line in listToArray( arguments.raw, chr(10) ) ) {
            var trimmed = trim( line );
            if ( !len( trimmed ) || !find( ":", trimmed ) ) {
                continue;
            }
            out.append( {
                  name  = trim( listFirst( trimmed, ":" ) )
                , value = trim( listRest( trimmed, ":" ) )
            } );
        }
        return out;
    }

    if ( len( form.mode ) ) {
        var hdrs  = parseHeaders( form.headers );
        var began = getTickCount();
        try {
            switch ( form.mode ) {

                case "get":
                    sent = "GET " & form.target & ( len( form.qs ) ? " (+ query string)" : "" );
                    cfhttp( url = form.target, method = "GET", result = "result", throwOnError = false ) {
                        for ( var h in hdrs ) {
                            cfhttpparam( type = "header", name = h.name, value = h.value );
                        }
                        for ( var pair in listToArray( form.qs, "&" ) ) {
                            if ( find( "=", pair ) ) {
                                cfhttpparam(
                                      type  = "url"
                                    , name  = listFirst( pair, "=" )
                                    , value = urlDecode( listRest( pair, "=" ) )
                                );
                            }
                        }
                    }
                break;

                case "post":
                    sent = "POST " & form.target & " with a " & len( form.body ) & "-byte body";
                    cfhttp( url = form.target, method = "POST", result = "result", throwOnError = false ) {
                        for ( var h in hdrs ) {
                            cfhttpparam( type = "header", name = h.name, value = h.value );
                        }
                        cfhttpparam( type = "body", value = form.body );
                    }
                break;

                case "form":
                    sent = "POST " & form.target & " as application/x-www-form-urlencoded";
                    cfhttp( url = form.target, method = "POST", result = "result", throwOnError = false ) {
                        for ( var h in hdrs ) {
                            cfhttpparam( type = "header", name = h.name, value = h.value );
                        }
                        cfhttpparam( type = "formfield", name = form.field, value = form.fieldval );
                    }
                break;

                case "upload":
                    sent = "POST " & form.target & " as multipart/form-data, "
                         & "file """ & form.filename & """ (" & len( form.filebody ) & " bytes)";
                    // On a Worker `file=` names the upload and `value=` carries
                    // the content: there is no filesystem to read a path from.
                    cfhttp( url = form.target, method = "POST", result = "result", throwOnError = false ) {
                        for ( var h in hdrs ) {
                            cfhttpparam( type = "header", name = h.name, value = h.value );
                        }
                        cfhttpparam( type = "formfield", name = form.field, value = form.fieldval );
                        cfhttpparam(
                              type     = "file"
                            , name     = "file"
                            , file     = form.filename
                            , mimetype = form.mimetype
                            , value    = form.filebody
                        );
                    }
                break;

            }
        } catch ( any e ) {
            threw = e.message & ( len( e.detail ?: "" ) ? " — " & e.detail : "" );
        }
        elapsed = getTickCount() - began;
    }
</cfscript>
<cfinclude template="includes/header.cfm">
<cfoutput>

<div class="panel">
    <div class="panel-header">Outbound HTTP test bench</div>
    <div class="panel-body">
        <p>Unlisted page. Every button below performs a real
        <code>&lt;cfhttp&gt;</code> from this Worker to the URL in the target
        field, through the Workers <code>fetch</code> API via a JSPI suspending
        import. Point it at your <a href="https://requesthook.com/" rel="noopener">requesthook.com</a>
        endpoint and inspect what arrives.</p>
        <p><strong>Note on uploads:</strong> a Worker has no filesystem, so
        <code>&lt;cfhttpparam type="file"&gt;</code> takes the content in
        <code>value=</code> and uses <code>file=</code> only as the filename to
        present. The multipart body is assembled in memory.</p>
    </div>
</div>

<form method="post" action="/http.cfm">
<div class="panel">
    <div class="panel-header">Request</div>
    <div class="panel-body">
        <p><label><strong>Target URL</strong><br>
        <input type="text" name="target" value="#encodeForHTMLAttribute( form.target )#" style="width:100%"></label></p>

        <p><label><strong>Headers</strong> — one per line, <code>Name: value</code><br>
        <textarea name="headers" rows="3" style="width:100%">#encodeForHTML( form.headers )#</textarea></label></p>

        <p><label><strong>Query string</strong> for the GET — <code>a=1&amp;b=2</code><br>
        <input type="text" name="qs" value="#encodeForHTMLAttribute( form.qs )#" style="width:100%"></label></p>

        <p><label><strong>Body</strong> for the raw POST<br>
        <textarea name="body" rows="3" style="width:100%">#encodeForHTML( form.body )#</textarea></label></p>

        <p><label><strong>Form field</strong> sent with the urlencoded POST and the upload<br>
        <input type="text" name="field" value="#encodeForHTMLAttribute( form.field )#" size="20">
        =
        <input type="text" name="fieldval" value="#encodeForHTMLAttribute( form.fieldval )#" size="40"></label></p>

        <p><label><strong>Upload</strong> — filename, mime type, then the content<br>
        <input type="text" name="filename" value="#encodeForHTMLAttribute( form.filename )#" size="24">
        <input type="text" name="mimetype" value="#encodeForHTMLAttribute( form.mimetype )#" size="20"><br>
        <textarea name="filebody" rows="4" style="width:100%">#encodeForHTML( form.filebody )#</textarea></label></p>

        <p>
            <button type="submit" name="mode" value="get">Send GET</button>
            <button type="submit" name="mode" value="post">Send POST (raw body)</button>
            <button type="submit" name="mode" value="form">Send POST (form fields)</button>
            <button type="submit" name="mode" value="upload">Send file upload (multipart)</button>
        </p>
    </div>
</div>
</form>

<cfif len( form.mode )>
    <div class="panel">
        <div class="panel-header">Result — #encodeForHTML( sent )#</div>
        <div class="panel-body">
            <cfif len( threw )>
                <p class="bad">Threw: #encodeForHTML( threw )#</p>
            <cfelse>
                <table>
                    <tr><th>round trip</th><td><code>#elapsed# ms</code></td></tr>
                    <tr><th>statusCode</th><td><code>#encodeForHTML( result.statusCode ?: "" )#</code></td></tr>
                    <tr><th>status_code</th><td><code>#encodeForHTML( result.status_code ?: "" )#</code></td></tr>
                    <tr><th>responseHeader.status_code</th><td><code>#encodeForHTML( result.responseHeader.status_code ?: "" )#</code></td></tr>
                    <tr><th>mimeType</th><td><code>#encodeForHTML( result.mimeType ?: "" )#</code></td></tr>
                    <tr><th>charset</th><td><code>#encodeForHTML( result.charset ?: "" )#</code></td></tr>
                    <tr><th>errorDetail</th><td><code>#encodeForHTML( len( result.errorDetail ?: "" ) ? result.errorDetail : "(none)" )#</code></td></tr>
                </table>

                <p><strong>Response headers</strong></p>
                <table>
                <cfloop collection="#result.responseHeader ?: {}#" item="hname">
                    <tr><th>#encodeForHTML( hname )#</th><td><code>#encodeForHTML( left( toString( result.responseHeader[ hname ] ), 300 ) )#</code></td></tr>
                </cfloop>
                </table>

                <p><strong>fileContent</strong></p>
                <pre>#encodeForHTML( left( result.fileContent ?: "", 4000 ) )#</pre>
            </cfif>
        </div>
    </div>
</cfif>

</cfoutput>
<cfinclude template="includes/footer.cfm">
