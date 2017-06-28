var incidents;

function getParameterByName(name) {
    name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
    var regex = new RegExp("[\\?&]" + name + "=([^&#]*)"),
        results = regex.exec(location.search);
    return results === null ? null : decodeURIComponent(results[1].replace(/\+/g, " "));
}

function PDRequest(token, endpoint, method, options) {

	if ( !token ) {
		alert("Please put a token in the URL, like .../index.html?token=<YOUR_V2_API_TOKEN>");
		return;
	}

	var merged = $.extend(true, {}, {
		type: method,
		dataType: "json",
		url: "https://api.pagerduty.com/" + endpoint,
		headers: {
			"Authorization": "Token token=" + token,
			"Accept": "application/vnd.pagerduty+json;version=2"
		},
		error: function(err, textStatus) {
			$('.busy').hide();
			var alertStr = "Error '" + err.status + " - " + err.statusText + "' while attempting " + method + " request to '" + endpoint + "'";
			try {
				alertStr += ": " + err.responseJSON.error.message;
			} catch (e) {
				alertStr += ".";
			}
			
			try {
				alertStr += "\n\n" + err.responseJSON.error.errors.join("\n");
			} catch (e) {}

			alert(alertStr);
		}
	},
	options);

	$.ajax(merged);
}


function fetchTeams(callback, offset, teams) {
	var options = {
		success: function(data) {
			Array.prototype.push.apply(teams, data.teams);
			if ( data.more == true ) {
				fetchTeams(callback, data.offset + data.limit, teams);
			} else {
				callback(teams);
			}
		}
	}
	if ( offset ) {
		options.data.offset = offset;
	}
	if ( ! teams ) {
		teams = [];
	}

	PDRequest(getParameterByName('token'), "teams", "GET", options);
}


function fetchIncidents(since, until, callback, offset, incidents) {
	var options = {
		data: {
			since: since.toISOString(),
			until: until.toISOString(),
			"statuses[]": "resolved"
		},
		success: function(data) {
			Array.prototype.push.apply(incidents, data.incidents);
			if ( data.more == true ) {
				fetchIncidents(since, until, callback, data.offset + data.limit, incidents);
			} else {
				callback(incidents);
			}
		}
	}
	if ( offset ) {
		options.data.offset = offset;
	}
	
	if ( $('#team-select').val() !== 'all' ) {
		options.data['team_ids[]'] = $('#team-select').val();
	}

	if ( ! incidents ) {
		incidents = [];
	}

	PDRequest(getParameterByName('token'), "incidents", "GET", options);
}


function buildReport(since, until) {
	$('.busy').show();
	console.log(`Team selected: ${$('#team-select').val()}; Since: ${since}; Until: ${until}`);
	async.series([
		function(callback) {
			fetchIncidents(since, until, function(fetchedData) {
				incidents = fetchedData;
				callback(null, fetchedData);
			});
		},
		function(callback) {
			console.log(`fetched ${incidents.length} incidents`);
			callback(null, 'yay');
		}
	],
	function(err, results) {
		var teamName = $('#team-select option:selected').text();
		var sinceStr = moment(since).format("LLLL");
		var untilStr = moment(until).format("LLLL");

		var workStartHHmm = $('#work-start-select').val().split(':');
		var workStart = moment().tz($('#tz-select').val()).hours(workStartHHmm[0]).minutes(workStartHHmm[1]);

		var workEndHHmm = $('#work-end-select').val().split(':');
		var workEnd = moment().tz($('#tz-select').val()).hours(workEndHHmm[0]).minutes(workEndHHmm[1]);
		
		if( workEnd.isBefore(workStart) ) {
			workEnd.add(1, 'days');
		}

		var headline = `Incidents belonging to ${teamName} occurring between ${sinceStr} and ${untilStr}`;
		$('#result').html('<h3>' + headline + '</h3>');
		$('#result').append($('<table/>', {
			id: "result-table"
		}));
		var tableData = [];
		console.log(`got ${incidents.length} incidents`);
		incidents.forEach(function(incident) {
			var created = moment.tz(incident.created_at, $('#tz-select').val());
			var resolved = moment.tz(incident.last_status_change_at, $('#tz-select').val());
			var duration = moment.duration(created.diff(resolved)).humanize();
			var createdTime = moment().tz($('#tz-select').val()).hours(created.hours()).minutes(created.minutes());
			
			if ( createdTime.isBetween(workStart, workEnd) ) {
				console.log(`${incident.incident_number}: ${createdTime} is between ${workStart} and ${workEnd}`);
			} else {
				console.log(`${incident.incident_number}: ${createdTime} is NOT between ${workStart} and ${workEnd}`);
			}
			tableData.push([
				'<a href="' + incident.html_url + '" target="blank">' + incident.incident_number + '</a>',
				created.format('l LTS [GMT]ZZ'),
				createdTime.isBetween(workStart, workEnd) ? "" : "X",
				resolved.format('l LTS [GMT]ZZ'),
				( incident.last_status_change_by.type == 'user_reference' ) ? incident.last_status_change_by.summary : "auto-resolved",
				duration,
//				incident.status,
				incident.service.summary,
				incident.summary
			]);
		});
		$('#result-table').DataTable({
			data: tableData,
			columns: [
				{ title: "#" },
				{ title: "Created at" },
				{ title: "Off-Hours" },
				{ title: "Resolved at" },
				{ title: "resolved by" },
				{ title: "Time to Resolve" },
//				{ title: "Status" },
				{ title: "Service Name" },
				{ title: "Summary" }
			]
		});

		console.log("all done");
		$('.busy').hide();
	});
}

function main() {
	$('#since').datepicker();
	$('#until').datepicker();

	if (getParameterByName('hideControls') == 'true') {
		$('#controls').hide();
	}

	var until = new Date();
	var since = new Date();
	since.setMonth(since.getMonth() - 1);

	since.setHours(0,0,0,0);
	until.setHours(23,59,59,999);

	$('#since').datepicker("setDate", since);
	$('#until').datepicker("setDate", until);
	
	for ( h = 0; h < 24; h++ ) { 
		for (m = 0; m < 60; m += 30 ) {
			var timeStr = moment().hour(h).minute(m).format("HH:mm");
			$('#work-start-select,#work-end-select').append($('<option/>', {
				value: timeStr,
				text: timeStr
			}));
		}
	}
	
	if ( ! localStorage.getItem('workstart') ) {
		localStorage.setItem('workstart', '08:00');
	}

	if ( ! localStorage.getItem('workend') ) {
		localStorage.setItem('workend', '20:00');
	}
	
	$('#work-start-select').val(localStorage.getItem('workstart'));
	$('#work-end-select').val(localStorage.getItem('workend'));
	
	moment.tz.names().forEach(function(tzName) {
		$('#tz-select').append($('<option/>', {
			value: tzName,
			text: tzName
		}));
	});
	
	if ( ! localStorage.getItem('timezone') ) {
		localStorage.setItem('timezone', moment.tz.guess() );
	}

	$('#tz-select').val(localStorage.getItem('timezone'));
	
	async.series([
		function(callback) {
			fetchTeams(function(teams) {
				console.log(`Fetched ${teams.length} teams.`);
				$('#team-select').html('');
				$('#team-select').append($('<option/>', {
					value: 'all',
					text: 'All Teams'
				}));
		
				teams.forEach(function(team) {
					$('#team-select').append($('<option/>', {
						value: team.id,
						text: team.summary
					}));
				});
				callback(null, 'yay');
			});
		}
	],
	function(err, results) {
		buildReport(since, until);
	});

	$('#since').change(function() {
		since = $('#since').datepicker("getDate");
		since.setHours(0,0,0,0);

		buildReport(since, until);
	});

	$('#until').change(function() {
		until = $('#until').datepicker("getDate");
		until.setHours(23,59,59,999);
		
		buildReport(since, until);
	});

	$('#team-select').change(function() {
		buildReport(since, until);
	});
	
	$('#tz-select').change(function() {
		localStorage.setItem('timezone', $('#tz-select').val());
	});
	$('#work-start-select').change(function() {
		localStorage.setItem('workstart', $('#work-start-select').val());
	});
	$('#work-end-select').change(function() {
		localStorage.setItem('workend', $('#work-end-select').val());
	});
}

$(document).ready(main);