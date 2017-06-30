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
		options['data'] = { offset: offset };
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
		$('#details').html('<h3>' + headline + '</h3>');
		$('#details').append($('<table/>', {
			id: "details-table",
			class: "display"
		}));
		$('#details-table').append('<thead><tr></tr></thead><tbody></tbody><tfoot><tr><th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th></tr></tfoot>');
		
		var tableData = [];
		var resolvers = {};
		console.log(`got ${incidents.length} incidents`);
		incidents.forEach(function(incident) {
			var created = moment.tz(incident.created_at, $('#tz-select').val());
			var resolved = moment.tz(incident.last_status_change_at, $('#tz-select').val());
			var duration = moment.duration(created.diff(resolved));
			var createdTime = moment().tz($('#tz-select').val()).hours(created.hours()).minutes(created.minutes());
			var resolvedBy = ( incident.last_status_change_by.type == 'user_reference' ) ? incident.last_status_change_by.summary : "auto-resolved";

			if ( ! resolvers[resolvedBy] ) {
				resolvers[resolvedBy] = {
					onHoursTime: 0,
					offHoursTime: 0,
					onHoursIncidents: 0,
					offHoursIncidents: 0
				}
			}

			if ( createdTime.isBetween(workStart, workEnd) ) {
				resolvers[resolvedBy].onHoursTime += duration.seconds();
				resolvers[resolvedBy].onHoursIncidents++;
			} else {
				resolvers[resolvedBy].offHoursTime += duration.seconds();
				resolvers[resolvedBy].offHoursIncidents++;
			}

			tableData.push([
				'<a href="' + incident.html_url + '" target="blank">' + incident.incident_number + '</a>',
				created.format('l LTS [GMT]ZZ'),
				createdTime.isBetween(workStart, workEnd) ? "no" : "yes",
				resolved.format('l LTS [GMT]ZZ'),
				resolvedBy,
				duration.humanize(),
				incident.service.summary,
				incident.summary
			]);
		});

		// build details table
		var columnTitles = [
				{ title: "#" },
				{ title: "Created at" },
				{ title: "Off-Hours" },
				{ title: "Resolved at" },
				{ title: "Resolved by" },
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
	            this.api().columns([2,4,6]).every( function () {
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
		                console.log(`select option ${d}`);
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
		Object.keys(resolvers).forEach(function(resolver) {
			reportTableData.push([
				resolver,
				moment.duration(resolvers[resolver].onHoursTime, 'seconds').humanize(),
				resolvers[resolver].onHoursIncidents,
				moment.duration(resolvers[resolver].onHoursTime / resolvers[resolver].onHoursIncidents, 'seconds').humanize(),
				moment.duration(resolvers[resolver].offHoursTime, 'seconds').humanize(),
				resolvers[resolver].offHoursIncidents,
				moment.duration(resolvers[resolver].onHoursTime / resolvers[resolver].onHoursIncidents, 'seconds').humanize(),
			]);
		});
		var reportColumnTitles = [
				{ title: "User" },
				{ title: "On-Hours Time" },
				{ title: "On-Hours Incidents" },
				{ title: "On-Hours MTTR" },
				{ title: "Off-Hours Time" },
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





