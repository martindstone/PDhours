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

function fetchLogEntriesParallel(since, until, callback) {
	var limit = 100;
	var infoFns = [];
	var log_entries = [];

	var options = {
		data: {
			since: since.toISOString(),
			until: until.toISOString(),
			is_overview: false,
			total: true,
			limit: limit
		},
		success: function(data) {
			var total = data.total;
			Array.prototype.push.apply(log_entries, data.log_entries);

			if ( data.more == true ) {
				var indexes = [];
				for ( i = limit; i < total; i += limit ) {
					indexes.push(Number(i));
				}
				indexes.forEach(function(i) {
					var offset = i;
					infoFns.push(function(callback) {
						var options = {
							data: {
								since: since.toISOString(),
								until: until.toISOString(),
								is_overview: false,
								total: true,
								limit: limit,
								offset: offset
							},
							success: function(data) {
								Array.prototype.push.apply(log_entries, data.log_entries);
								var progress = Math.round((log_entries.length / data.total) * 100);
								$('#progressbar').attr("aria-valuenow", "" + progress);
								$('#progressbar').attr("style", "width: " + progress + "%;");
								$('#progressbar').html("" + progress + "%");
								callback(null, data);
							}
						}
						PDRequest(getParameterByName('token'), "log_entries", "GET", options);
					});
				});

				async.parallel(infoFns, function(err, results) {
					callback(log_entries);
				});
			} else {
				callback(log_entries);
			}
		}
	}
	PDRequest(getParameterByName('token'), "log_entries", "GET", options);
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

function buildReport(since, until) {
	$('.busy').show();
	loadingStarted = moment();
	async.series([
		function(callback) {
			fetchLogEntriesParallel(since, until, function(data) {
				$('#progressbar').attr("aria-valuenow", "0");
				$('#progressbar').attr("style", "width: 0%;");
				$('#progressbar').html("0%");
				$('.busy').hide();
				loadingFinished = moment();

				console.log(`loaded ${data.length} log entries in ${loadingFinished.diff(loadingStarted, 'seconds')} seconds`);

				incidents = {};
				data.forEach(function(le) {
					if ( ! incidents[le.incident.id] ) {
						incidents[le.incident.id] = {}
					}
					if ( ! incidents[le.incident.id][le.type] ) {
						incidents[le.incident.id][le.type] = [];
					}

					incidents[le.incident.id][le.type].push(le);
				});

				Object.keys(incidents).forEach(function(id) {
					if ( ! incidents[id]['trigger_log_entry'] ) {
						console.log(`incident ${id} has no trigger log entry. BALEETED.`);
						delete incidents[id];
					} else if ( ! incidents[id]['resolve_log_entry'] ) {
						console.log(`incident ${id} has no resolve log entry. BALEETED.`);
						delete incidents[id];
					} else {
						Object.keys(incidents[id]).forEach(function(leType) {
							incidents[id][leType].sort(compareCreatedAt);
						});

						incidents[id].ttr = moment(incidents[id]['resolve_log_entry'][0].created_at).diff(moment(incidents[id]['trigger_log_entry'][0].created_at), 'seconds');

						if ( incidents[id]['acknowledge_log_entry'] ) {
							incidents[id].tta = moment(incidents[id]['acknowledge_log_entry'][0].created_at).diff(moment(incidents[id]['trigger_log_entry'][0].created_at), 'seconds');
						}
					}
				});

				callback(null, incidents);
			});
		},
		function(callback) {
			callback(null, 'yay');
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

			var createdStr = incident.trigger_log_entry[0].created_at;
			var created = moment.tz(createdStr, $('#tz-select').val());

			var resolvedStr = incident.resolve_log_entry[0].created_at;
			var resolved = moment.tz(resolvedStr, $('#tz-select').val());
			
			var acknowledgedStr = "";
			var acknowledged = null;
			var time_to_first_ack = -1;
			
			if ( incident.acknowledge_log_entry ) {
				acknowledgedStr = incident.acknowledge_log_entry[0].created_at;
				acknowledged = moment.tz(acknowledgedStr, $('#tz-select').val());
				time_to_first_ack = acknowledged.diff(created, 'seconds');
			}

			var duration = moment.duration(resolved.diff(created));
			var durationSecs = resolved.diff(created, 'seconds');

			var createdTime = moment().tz($('#tz-select').val()).hours(created.hours()).minutes(created.minutes());
			var resolvedBy = ( incident.resolve_log_entry[0].agent.type == 'user_reference' ) ? incident.resolve_log_entry[0].agent.summary : "auto-resolved";

			var assignedTo = [];

			if ( incident.assign_log_entry ) {
				incident.assign_log_entry.forEach(function(le) {
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
							onHoursIncidents: 0,
							offHoursIncidents: 0
						}
					}
					if ( createdTime.isBetween(workStart, workEnd) ) {
						assignees[assignee].onHoursTime += durationSecs;
						assignees[assignee].onHoursIncidents++;
					} else {
						assignees[assignee].offHoursTime += durationSecs;
						assignees[assignee].offHoursIncidents++;
					}
				});
			} else {
				assignedTo = ['no one'];
			}
			var durationStr = duration.humanize();

			var serviceName = incident.trigger_log_entry[0].service.summary;
			var incidentSummary = incident.trigger_log_entry[0].incident.summary;
			var incidentNumber = incidentSummary.match(/\[#([\d]+)\]/)[1];
			var incidentURL = incident.trigger_log_entry[0].incident.html_url;

			tableData.push([
				'<a href="' + incidentURL + '" target="blank">' + incidentNumber + '</a>',
				created.format('l LTS [GMT]ZZ'),
				createdTime.isBetween(workStart, workEnd) ? "no" : "yes",
				assignedTo.join(', '),
				resolved.format('l LTS [GMT]ZZ'),
				resolvedBy,
				time_to_first_ack >= 0 ? moment.duration(time_to_first_ack, 'seconds').humanize() : "not acknowledged",
				duration.humanize(),
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
	                var select = $('<label for="' + columnTitles[column.index()].title + '">' + columnTitles[column.index()].title + '</label><select id="' + columnTitles[column.index()].title + '"><option value=""></option></select>')
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

			reportTableData.push([
				assignee,
				secondsToHHMMSS(assignees[assignee].onHoursTime),
				assignees[assignee].onHoursIncidents,
				onHoursMTTR,
				secondsToHHMMSS(assignees[assignee].offHoursTime),
				assignees[assignee].offHoursIncidents,
				offHoursMTTR,
			]);
		});
		var reportColumnTitles = [
				{ title: "User" },
				{ title: "On-Hours Time (HH:MM:SS)" },
				{ title: "On-Hours Incidents" },
				{ title: "On-Hours MTTR" },
				{ title: "Off-Hours Time (HH:MM:SS)" },
				{ title: "Off-Hours Incidents" },
				{ title: "Off-Hours MTTR" },
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

	var until = new Date();
	var since = new Date();
	since.setDate(since.getDate() - 7);

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
		buildReport(since, until);
	});

	$('#tz-select').change(function() {
		localStorage.setItem('timezone', $('#tz-select').val());
		buildReport(since, until);
	});
	$('#work-start-select').change(function() {
		localStorage.setItem('workstart', $('#work-start-select').val());
		buildReport(since, until);
	});
	$('#work-end-select').change(function() {
		localStorage.setItem('workend', $('#work-end-select').val());
		buildReport(since, until);
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
