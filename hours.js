var incidents;

function getParameterByName(name) {
	const params = new URLSearchParams(document.location.search.substring(1))
	const r = params.get(name)
	if (r && name === 'token') {
		return r.replace(' ', '+')
	}
	return r
}

function endpointIdentifier(endpoint) {
	if (endpoint.match(/users\/P.*\/sessions/)) {
		return 'user_sessions'
	}
	return endpoint.split('/').pop()
}

async function PDRequest(token, endpoint, method, params, data) {
	let url = `https://api.pagerduty.com/${endpoint}`
	if (params) {
		url += '?' + new URLSearchParams(params)
	}
	let body = null
	if (data) {
		body = JSON.stringify(data)
	}

	const response = await fetch(url, {
		method,
		headers: {
			"Authorization": `Token token=${token}`,
			"Accept": "application/vnd.pagerduty+json;version=2"
		},
		body
	})
	if (!response.ok) {
		console.log(response)
	}
	const responseData = await response.json()
	return responseData
}

async function PDFetch(token, endpoint, params, progressCallback) {
	let requestParams = {
		limit: 100,
		total: true,
		offset: 0
	}
	if (params) {
		requestParams = {...requestParams, ...params}
	}


	let reversedSortOrder = false
	if (endpoint.indexOf('log_entries') > -1) {
		reversedSortOrder = true
	}

	const firstPage = await PDRequest(token, endpoint, 'GET', requestParams)
	console.log(`total is ${firstPage.total}`)
	let fetchedData = [...firstPage[endpointIdentifier(endpoint)]]
	requestParams.offset += requestParams.limit

	let promises = []
	let outerOffset = 0
	while (outerOffset + requestParams.offset < firstPage.total) {
		while ((outerOffset + requestParams.offset < firstPage.total) && (requestParams.offset < 10000)) {
			const promise = PDRequest(token, endpoint, 'GET', requestParams)
				.then(page => {
					fetchedData = [...fetchedData, ...page[endpointIdentifier(endpoint)]]
					if (progressCallback) {
						progressCallback(firstPage.total, fetchedData.length)
					}
				})
				.catch(error => {
					console.log(error)
				})
			promises.push(promise)
			requestParams.offset += requestParams.limit
			if (promises.length > 10) {
				await Promise.all(promises)
				promises = []
			}
		}
		await Promise.all(promises)
		fetchedData.sort((a, b) => {
			return reversedSortOrder ? compareCreatedAt(b, a) : compareCreatedAt(a, b)
		})
		requestParams[reversedSortOrder ? 'until' : 'since'] = fetchedData[fetchedData.length - 1].created_at
		console.log(`hit 10000 request limit, setting outer offset to ${fetchedData.length} and setting ${reversedSortOrder ? 'until' : 'since'} to ${fetchedData[fetchedData.length - 1].created_at}`)
		outerOffset = fetchedData.length
		requestParams.offset = 0
	}
	console.log(`got ${fetchedData.length} ${endpointIdentifier(endpoint)}`)
	fetchedData.sort((a, b) => {
		return reversedSortOrder ? compareCreatedAt(b, a) : compareCreatedAt(a, b)
	})
	return fetchedData
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

function setProgressBarPercent(total, done) {
	progress_percent = Math.round(done / total * 100);
	$('#progressbar').attr("aria-valuenow", "" + progress_percent);
	$('#progressbar').attr("style", "width: " + progress_percent + "%;");
	$('#progressbar').html("" + progress_percent + "%");
}

async function fetchReportData(since, until, callback) {
	
	const progress = {
		incidents: {
			total: 0,
			done: 0
		},
		log_entries: {
			total: 0,
			done: 0
		}
	};

	let params = {
		since: since.toISOString(),
		until: until.toISOString()
	}

	$('#busy-message').html('<h1>Fetching log entries...</h1>')
	const log_entries = await PDFetch(getParameterByName('token'), 'log_entries', params, setProgressBarPercent)

	params = {
		...params,
		'statuses[]': 'resolved'
	}
	$('#busy-message').html('<h1>Fetching incidents...</h1>')
	setProgressBarPercent(1, 0)
	const fetchedIncidents = await PDFetch(getParameterByName('token'), 'incidents', params, setProgressBarPercent)

	return {
		log_entries,
		fetchedIncidents
	}
}

function parseReportData(log_entries, fetchedIncidents) {
	$('#busy-message').html('<h1>Parsing incidents...</h1>');
	var incidents = {};

	for (const incident of fetchedIncidents) {
		incidents[incident.id] = incident
		incidents[incident.id].log_entries = {}
	}

	$('#busy-message').html('<h1>Adding log entries to incidents...</h1>');
	for (const le of log_entries) {
		if ( incidents[le.incident.id] ) {
			if ( ! incidents[le.incident.id]['log_entries'][le.type] ) {
				incidents[le.incident.id]['log_entries'][le.type] = [];
			}
			incidents[le.incident.id]['log_entries'][le.type].push(le);
		}
	}

	$('#busy-message').html('<h1>Sorting incident log entries...</h1>');
	for (const id of Object.keys(incidents)) {
		for (const leType of Object.keys(incidents[id]['log_entries'])) {
			incidents[id]['log_entries'][leType].sort(compareCreatedAt);
		}

		const create_time = moment(incidents[id].created_at)
		const resolve_time = moment(incidents[id]['log_entries']['resolve_log_entry'][0].created_at)
		incidents[id].ttr = resolve_time.diff(create_time, 'seconds');

		if ( incidents[id]['log_entries']['acknowledge_log_entry'] ) {
			const ack_time = moment(incidents[id]['log_entries']['acknowledge_log_entry'][0].created_at)
			incidents[id].tta = ack_time.diff(create_time, 'seconds');
		}
	}
	
	return incidents;
}


async function buildReport(since, until, reuseFetchedData) {
	$('.busy').show();

	if (!reuseFetchedData) {
		const {log_entries, fetchedIncidents} = await fetchReportData(since, until)

		incidents = parseReportData(log_entries, fetchedIncidents)
	}

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
	$('#details-table').append('<thead><tr></tr></thead><tbody></tbody><tfoot><tr><th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th></tr></tfoot>');

	var tableData = [];
	var assignees = {};
	for (const [incidentID, incident] of Object.entries(incidents)) {
		if ( ! incident.log_entries.trigger_log_entry ) {
			delete incidents[incidentID];
			return;
		}
		if ( ! incident.log_entries.resolve_log_entry ) {
			delete incidents[incidentID];
			return;
		}
		// if ( teamID != 'all' && ( ! incident.teams || incident.teams.map(function(team){return team.id}).indexOf(teamID) == -1 ) ) {
		// 	var team_names = incident.teams ? incident.teams.map(function(team){return team.id}).join(', ') : '(no teams)';
		// 	return;
		// }

		const tz = $('#tz-select').val()
		var createdStr = incident.log_entries.trigger_log_entry[0].created_at;
		var created = moment.tz(createdStr, tz);
		var createdTime = moment().tz(tz).hours(created.hours()).minutes(created.minutes());

		var resolvedStr = incident.log_entries.resolve_log_entry[0].created_at;
		var resolved = moment.tz(resolvedStr, tz);

		var acknowledgedStr = "";
		var acknowledged = null;
		
		if ( incident.acknowledge_log_entry ) {
			acknowledgedStr = incident.log_entries.acknowledge_log_entry[0].created_at;
			acknowledged = moment.tz(acknowledgedStr, tz);
		}

		var resolvedBy = ( incident.log_entries.resolve_log_entry[0].agent.type == 'user_reference' ) ? incident.log_entries.resolve_log_entry[0].agent.summary : "auto-resolved";

		var assignedTo = [];

		if ( incident.log_entries.assign_log_entry ) {
			for (const le of incident.log_entries.assign_log_entry) {
				for (const assignee of le.assignees) {
					if ( assignee.type == 'user_reference' ) {
						assignedTo.push(assignee.summary);
					}
				}
			}
			assignedTo = unique(assignedTo);
			assignedTo.sort();
			for (assignee of assignedTo) {
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
			}
		} else {
			assignedTo = ['no one'];
		}

		var serviceName = incident.service.summary;
		var incidentSummary = incident.summary;
		var incidentNumber = `${incident.incident_number}`
		var incidentURL = incident.html_url;

		tableData.push([
			'<a href="' + incidentURL + '" target="blank">' + incidentNumber + '</a>',
			incident.alert_counts.all,
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
	}

	// build details table
	var columnTitles = [
			{ title: "#" },
			{ title: "# Alerts" },
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
			this.api().columns([3,4,6,7,8,9]).every( function () {
					var column = this;
					var columnTitle = columnTitles[column.index()].title;
					var select = $('<select id="' + columnTitle + '"><option value="">' + columnTitle + ': (all)</option></select>')
							.appendTo( $(column.footer()) )
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

	for (const [assignee_name, assignee] of Object.entries(assignees)) {
		var onHoursMTTR = 'n/a';
		if ( assignee.onHoursIncidents && assignee.onHoursTime ) {
			onHoursMTTR = moment.duration(assignee.onHoursTime / assignee.onHoursIncidents, 'seconds').humanize()
		}

		var offHoursMTTR = 'n/a';
		if ( assignee.offHoursIncidents && assignee.offHoursTime ) {
			offHoursMTTR = moment.duration(assignee.offHoursTime / assignee.offHoursIncidents, 'seconds').humanize()
		}


		var onHoursMTTA = 'n/a';
		if ( assignee.onHoursIncidents && assignee.onHoursTTA ) {
			onHoursMTTA = moment.duration(assignee.onHoursTTA / assignee.onHoursIncidents, 'seconds').humanize()
		}

		var offHoursMTTA = 'n/a';
		if ( assignee.offHoursIncidents && assignee.offHoursTTA ) {
			offHoursMTTA = moment.duration(assignee.offHoursTTA / assignee.offHoursIncidents, 'seconds').humanize()
		}


		reportTableData.push([
			assignee_name,
			secondsToHHMMSS(assignee.onHoursTime),
			assignee.onHoursIncidents,
			onHoursMTTR,
			onHoursMTTA,
			secondsToHHMMSS(assignee.offHoursTime),
			assignee.offHoursIncidents,
			offHoursMTTR,
			offHoursMTTA
		]);
	}
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

}

async function main() {
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

	const teams = await PDFetch(getParameterByName('token'), 'teams')
	$('#team-select').html('');
	$('#team-select').append($('<option/>', {
		value: 'all',
		text: 'All Teams'
	}));
	for (team of teams) {
		$('#team-select').append($('<option/>', {
			value: team.id,
			text: team.summary
		}));
	}
	buildReport(since, until)

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

(() => {
	main()
})()
