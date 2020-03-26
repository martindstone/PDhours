var incidents;
var loadingStarted, loadingFinished;

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
		options['data'] = { offset: offset };
	}
	if ( ! teams ) {
		teams = [];
	}

	PDRequest(getParameterByName('token'), "teams", "GET", options);
}


function fetch(endpoint, params, callback, progressCallback) {
	var limit = 100;
	var infoFns = [];
	var fetchedData = [];

	var commonParams = {
			total: true,
			limit: limit
	};

	var getParams = $.extend(true, {}, params, commonParams);

	var options = {
		data: getParams,
		success: function(data) {
			var total = data.total;
			Array.prototype.push.apply(fetchedData, data[endpoint]);

			if ( data.more == true ) {
				var indexes = [];
				for ( i = limit; i < total; i += limit ) {
					indexes.push(Number(i));
				}
				indexes.forEach(function(i) {
					var offset = i;
					infoFns.push(function(callback) {
						var options = {
							data: $.extend(true, { offset: offset }, getParams),
							success: function(data) {
								Array.prototype.push.apply(fetchedData, data[endpoint]);
								if (progressCallback) {
									progressCallback(data.total, fetchedData.length);
								}
								callback(null, data);
							}
						}
						PDRequest(getParameterByName('token'), endpoint, "GET", options);
					});
				});

				async.parallel(infoFns, function(err, results) {
					callback(fetchedData);
				});
			} else {
				callback(fetchedData);
			}
		}
	}
	PDRequest(getParameterByName('token'), endpoint, "GET", options);
}

function fetchLogEntries(since, until, callback, progressCallback) {
	var params = {
		since: since.toISOString(),
		until: until.toISOString(),
		is_overview: false
	}
	fetch('log_entries', params, callback, progressCallback);
}

function fetchIncidents(since, until, callback, progressCallback) {
	var params = {
		since: since.toISOString(),
		until: until.toISOString(),
		'statuses[]': 'resolved'
	}
	fetch('incidents', params, callback, progressCallback);
}

function compareCreatedAt(a, b) {
	return moment(a.created_at).diff(moment(b.created_at));
}

function secondsToHHMMSS(seconds) {
	var hours = Math.floor(seconds / 60 / 60);
	var minutes = Math.floor((seconds % 3600) / 60);
	var seconds = seconds % 60;

	var HH = ('0' + hours).slice(-2);
	var MM = ('0' + minutes).slice(-2);
	var SS = ('0' + seconds).slice(-2);

	return `${HH}:${MM}:${SS}`;
}

function unique(array) {
	return array.filter( function(value, index, self) {
		return self.indexOf(value) === index;
	});
}

function fetchReportData(since, until, callback) {
	var progress = {
		incidents: {
			total: 0,
			done: 0
		},
		log_entries: {
			total: 0,
			done: 0
		}
	};

	async.parallel([
		function(callback) {
			fetchLogEntries(since, until, function(data) {
				callback(null, data);
			},
			function(total, done) {
				progress.log_entries.total = total;
				progress.log_entries.done = done;
				progress_percent = Math.round(( progress.incidents.done + progress.log_entries.done ) / ( progress.incidents.total + progress.log_entries.total ) * 100);
				$('#progressbar').attr("aria-valuenow", "" + progress_percent);
				$('#progressbar').attr("style", "width: " + progress_percent + "%;");
				$('#progressbar').html("" + progress_percent + "%");
			});
		},
		function(callback) {
			fetchIncidents(since, until, function(data) {
				callback(null, data);
			},
			function(total, done) {
				progress.incidents.total = total;
				progress.incidents.done = done;
				progress_percent = Math.round(( progress.incidents.done + progress.log_entries.done ) / ( progress.incidents.total + progress.log_entries.total ) * 100);
				$('#progressbar').attr("aria-valuenow", "" + progress_percent);
				$('#progressbar').attr("style", "width: " + progress_percent + "%;");
				$('#progressbar').html("" + progress_percent + "%");
			});
		}
	],
	function(err, results) {
		callback(results);
	});
}

function parseReportData(log_entries, fetchedIncidents) {
	$('#busy-message').html('<h1>Parsing incidents...</h1>');
	var incidents = {};
	fetchedIncidents.forEach(function (incident) {
		incidents[incident.id] = incident;
		incidents[incident.id].log_entries = {};
	});

	$('#busy-message').html('<h1>Adding log entries to incidents...</h1>');
	log_entries.forEach(function(le) {
		if ( incidents[le.incident.id] ) {
			if ( ! incidents[le.incident.id]['log_entries'][le.type] ) {
				incidents[le.incident.id]['log_entries'][le.type] = [];
			}
			incidents[le.incident.id]['log_entries'][le.type].push(le);
		}
	});

	$('#busy-message').html('<h1>Sorting incident log entries...</h1>');
	Object.keys(incidents).forEach(function(id) {
		Object.keys(incidents[id]['log_entries']).forEach(function(leType) {
			incidents[id]['log_entries'][leType].sort(compareCreatedAt);
		});

		incidents[id].ttr = moment(incidents[id]['log_entries']['resolve_log_entry'][0].created_at).diff(moment(incidents[id].created_at), 'seconds');

		if ( incidents[id]['log_entries']['acknowledge_log_entry'] ) {
			console.log("Acknowledged at " + moment(incidents[id]['log_entries']['acknowledge_log_entry'][0].created_at).format('llll') + ", triggered at " + moment(incidents[id].created_at).format('llll') + ", diff " + moment(incidents[id]['log_entries']['acknowledge_log_entry'][0].created_at).diff(moment(incidents[id].created_at), 'seconds') );
			incidents[id].tta = moment(incidents[id]['log_entries']['acknowledge_log_entry'][0].created_at).diff(moment(incidents[id].created_at), 'seconds');
		}
	});
	
	return incidents;
}


function buildReport(since, until, reuseFetchedData) {
	$('.busy').show();
	loadingStarted = moment();

	async.series([
		function(callback) {
			if ( reuseFetchedData ) {
				callback(null, 'yay');
			} else {
				fetchReportData(since, until, function(results) {
					incidents = parseReportData(results[0], results[1]);
					callback(null, 'yay');
				});
			}
		}
	],
	function(err, results) {
		var teamName = $('#team-select option:selected').text();
		var teamID = $('#team-select option:selected').val();
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
		$('#details').html('<h3>' + headline + '</h3>');
		$('#details').append($('<table/>', {
			id: "details-table",
			class: "display"
		}));
		$('#details-table').append('<thead><tr></tr></thead><tbody></tbody><tfoot><tr><th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th></tr></tfoot>');

		var tableData = [];
		var assignees = {};
		Object.keys(incidents).forEach(function(incidentID) {
			var incident = incidents[incidentID];
			
			if ( ! incident.log_entries.trigger_log_entry ) {
				delete incidents[incidentID];
				return;
			}
			if ( ! incident.log_entries.resolve_log_entry ) {
				delete incidents[incidentID];
				return;
			}
			if ( teamID != 'all' && ( ! incident.teams || incident.teams.map(function(team){return team.id}).indexOf(teamID) == -1 ) ) {
				var team_names = incident.teams ? incident.teams.map(function(team){return team.id}).join(', ') : '(no teams)';
				return;
			}

			var createdStr = incident.log_entries.trigger_log_entry[0].created_at;
			var created = moment.tz(createdStr, $('#tz-select').val());
			var createdTime = moment().tz($('#tz-select').val()).hours(created.hours()).minutes(created.minutes());

			var resolvedStr = incident.log_entries.resolve_log_entry[0].created_at;
			var resolved = moment.tz(resolvedStr, $('#tz-select').val());
	
			var acknowledgedStr = "";
			var acknowledged = null;
			
			if ( incident.acknowledge_log_entry ) {
				acknowledgedStr = incident.log_entries.acknowledge_log_entry[0].created_at;
				acknowledged = moment.tz(acknowledgedStr, $('#tz-select').val());
			}

			var resolvedBy = ( incident.log_entries.resolve_log_entry[0].agent.type == 'user_reference' ) ? incident.log_entries.resolve_log_entry[0].agent.summary : "auto-resolved";

			var assignedTo = [];

			if ( incident.log_entries.assign_log_entry ) {
				incident.log_entries.assign_log_entry.forEach(function(le) {
					le.assignees.forEach(function(assignee) {
						if ( assignee.type == 'user_reference' ) {
							assignedTo.push(assignee.summary);
						}
					});
				});
				assignedTo = unique(assignedTo);
				assignedTo.sort();
				assignedTo.forEach(function (assignee) {
					if ( ! assignees[assignee] ) {
						assignees[assignee] = {
							onHoursTime: 0,
							offHoursTime: 0,
							onHoursTTA: 0,
							offHoursTTA: 0,
							onHoursIncidents: 0,
							offHoursIncidents: 0
						}
					}
					if ( createdTime.isBetween(workStart, workEnd) ) {
						assignees[assignee].onHoursTime += incident.ttr;
						assignees[assignee].onHoursTTA += incident.tta;
						assignees[assignee].onHoursIncidents++;
					} else {
						assignees[assignee].offHoursTime += incident.ttr;
						assignees[assignee].offHoursTTA += incident.tta;
						assignees[assignee].offHoursIncidents++;
					}
				});
			} else {
				assignedTo = ['no one'];
			}

			var serviceName = incident.log_entries.trigger_log_entry[0].service.summary;
			var incidentSummary = incident.log_entries.trigger_log_entry[0].incident.summary;
			var incidentNumber = incidentSummary.match(/\[#([\d]+)\]/)[1];
			var incidentURL = incident.log_entries.trigger_log_entry[0].incident.html_url;

			tableData.push([
				'<a href="' + incidentURL + '" target="blank">' + incidentNumber + '</a>',
				created.format('l LTS [GMT]ZZ'),
				createdTime.isBetween(workStart, workEnd) ? "no" : "yes",
				assignedTo.join(', '),
				resolved.format('l LTS [GMT]ZZ'),
				resolvedBy,
				incident.tta >= 0 ? moment.duration(incident.tta, 'seconds').humanize() : "not acknowledged",
				incident.ttr >= 0 ? moment.duration(incident.ttr, 'seconds').humanize() : "not resolved",
				serviceName,
				incidentSummary
			]);
		});

		// build details table
		var columnTitles = [
				{ title: "#" },
				{ title: "Created at" },
				{ title: "Off-Hours" },
				{ title: "Assigned to" },
				{ title: "Resolved at" },
				{ title: "Resolved by" },
				{ title: "Time to Acknowledge" },
				{ title: "Time to Resolve" },
				{ title: "Service Name" },
				{ title: "Summary" }
			];
		$('#details-table').DataTable({
			data: tableData,
			columns: columnTitles,
			dom: 'Bfrtip',
			buttons: [
				'copy', 'csv', 'excel', 'pdf', 'print'
			],
			initComplete: function () {
	            this.api().columns([2,3,5,7]).every( function () {
	                var column = this;
	                var columnTitle = columnTitles[column.index()].title;
	                var select = $('<select id="' + columnTitle + '"><option value="">' + columnTitle + ': (all)</option></select>')
	                    .appendTo( $(column.footer()).empty() )
	                    .on( 'change', function () {
	                        var val = $.fn.dataTable.util.escapeRegex(
	                            $(this).val()
	                        );

	                        column
	                            .search( val ? '^'+val+'$' : '', true, false )
	                            .draw();
	                    } );

	                column.data().unique().sort().each( function ( d, j ) {
	                    select.append( '<option value="'+d+'">'+d+'</option>' )
	                } );
	            } );
        	}
		});

		// build report table
		$('#report').html('<h3>' + headline + '</h3>');
		$('#report').append($('<table/>', {
			id: "report-table",
			class: "display"
		}));
		var reportTableData = [];

		Object.keys(assignees).forEach(function(assignee) {
			var onHoursMTTR = 'n/a';
			if ( assignees[assignee].onHoursIncidents && assignees[assignee].onHoursTime ) {
				onHoursMTTR = moment.duration(assignees[assignee].onHoursTime / assignees[assignee].onHoursIncidents, 'seconds').humanize()
			}

			var offHoursMTTR = 'n/a';
			if ( assignees[assignee].offHoursIncidents && assignees[assignee].offHoursTime ) {
				offHoursMTTR = moment.duration(assignees[assignee].offHoursTime / assignees[assignee].offHoursIncidents, 'seconds').humanize()
			}


			var onHoursMTTA = 'n/a';
			if ( assignees[assignee].onHoursIncidents && assignees[assignee].onHoursTTA ) {
				onHoursMTTA = moment.duration(assignees[assignee].onHoursTTA / assignees[assignee].onHoursIncidents, 'seconds').humanize()
			}

			var offHoursMTTA = 'n/a';
			if ( assignees[assignee].offHoursIncidents && assignees[assignee].offHoursTTA ) {
				offHoursMTTA = moment.duration(assignees[assignee].offHoursTTA / assignees[assignee].offHoursIncidents, 'seconds').humanize()
			}


			reportTableData.push([
				assignee,
				secondsToHHMMSS(assignees[assignee].onHoursTime),
				assignees[assignee].onHoursIncidents,
				onHoursMTTR,
				onHoursMTTA,
				secondsToHHMMSS(assignees[assignee].offHoursTime),
				assignees[assignee].offHoursIncidents,
				offHoursMTTR,
				offHoursMTTA
			]);
		});
		var reportColumnTitles = [
				{ title: "User" },
				{ title: "On-Hours Time (HH:MM:SS)" },
				{ title: "On-Hours Incidents" },
				{ title: "On-Hours MTTR" },
				{ title: "On-Hours MTTA" },
				{ title: "Off-Hours Time (HH:MM:SS)" },
				{ title: "Off-Hours Incidents" },
				{ title: "Off-Hours MTTR" },
				{ title: "Off-Hours MTTA" }
			];
		$('#report-table').DataTable({
			data: reportTableData,
			columns: reportColumnTitles,
			dom: 'Bfrtip',
			buttons: [
				'copy', 'csv', 'excel', 'pdf', 'print'
			]
		});

		$('.busy').hide();
	});
}

function main() {
	$('#since').datepicker();
	$('#until').datepicker();

	if (getParameterByName('hideControls') == 'true') {
		$('#controls').hide();
	}

	defaultHistoryDays = parseInt(getParameterByName('defaultHistoryDays')) || 7;

	var until = new Date();
	var since = new Date();
	since.setDate(since.getDate() - defaultHistoryDays);

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
		buildReport(since, until, true);
	});

	$('#tz-select').change(function() {
		localStorage.setItem('timezone', $('#tz-select').val());
		buildReport(since, until, true);
	});
	$('#work-start-select').change(function() {
		localStorage.setItem('workstart', $('#work-start-select').val());
		buildReport(since, until, true);
	});
	$('#work-end-select').change(function() {
		localStorage.setItem('workend', $('#work-end-select').val());
		buildReport(since, until, true);
	});
	$('#toggle-button').click(function() {
		if ( $('#details-row').is(':visible') ) {
			$('#details-row').hide();
			$('#report-row').show();
			$('#toggle-button').text('Show Details');
		} else {
			$('#report-row').hide();
			$('#details-row').show();
			$('#toggle-button').text('Show Summary');
		}
	});

	$('#report-row').hide();
	$('#report').html("<h3>oh hai</h3>");
}

$(document).ready(main);
