// The newest code emailed to EMAIL, read from the local stack's Mailpit (MAILPIT_URL, by default the port in
// supabase/config.toml): a sign-in code, or with SUBJECT "Confirm your HandsFreeOS email", the code that confirms a new
// account. Sets output.code for the flow.
var base = typeof MAILPIT_URL !== 'undefined' ? MAILPIT_URL : 'http://127.0.0.1:54424';
var subject = typeof SUBJECT !== 'undefined' ? SUBJECT : 'sign-in code';
var query = encodeURIComponent('to:' + EMAIL + ' subject:"' + subject + '"');
var found = json(http.get(base + '/api/v1/search?query=' + query + '&limit=1').body);
if (!found.messages || found.messages.length === 0)
  throw new Error('No "' + subject + '" email for ' + EMAIL);
var message = json(http.get(base + '/api/v1/message/' + found.messages[0].ID).body);
var match = /\b(\d{6})\b/.exec(message.Text || message.HTML || '');
if (!match) throw new Error('The email has no 6-digit code');
output.code = match[1];
