(function (global){	
	var nop = function () {};

	var Subscription = function (channel, path, onChangeCallback, successCallback, monitorInterval, publishInterval) {
		this.channel = channel;
		this.path = path;
		this.onChange = onChangeCallback || nop;
		
		this.subscriptionId = null;
		
		monitorInterval = monitorInterval || 0.02;
		publishInterval = publishInterval || 0.05;
		successCallback = successCallback || nop;
				
		this.unregister = function (successCallback) {
			return channel.client.invoke(
				"/SubscriptionService/UnregisterSubscription",
				{
					SubscriptionChannel: channel.channelId,
					SubscriptionId: this.subscriptionId
				},
				(function (result) {
					successCallback();
				}).bind(this)
			);
		}
		
		this.register = function (callback){
			return channel.client.invoke(
				"/SubscriptionService/RegisterSubscription",
				{
					SubscriptionChannel: channel.channelId,
					PropertyLink: path,
					MonitorInterval: monitorInterval,
					PublishInterval: publishInterval
				},
				(function (result) {
					this.subscriptionId = result;
					successCallback();
					if ( callback ){
						callback(this);
					}
				}).bind(this)
			);
		}
		
		this.register.call(this);
	};

	var SubscriptionChannel = function (client, notificationQueueSize, onCreateCallback) {
		this.client = client;
		this.onCreate = onCreateCallback;
		
		this.channelId = null;
		this.subscriptions = [];
		this.listenStarted = false;
		this.subscriptionsDictionary = {};
		
		var created = false;
		var channelLastNotificationId = 0;
		
		this.registerSubscription = function (path, onChangeCallback, successCallback, monitorInterval, publishInterval) {
			var newSubscription = new Subscription(this, path, onChangeCallback, (function (){
				this.subscriptionsDictionary[newSubscription.subscriptionId] = newSubscription;
				successCallback();
			}).bind(this), monitorInterval, publishInterval);
			this.subscriptions.push(newSubscription);
			if ( !this.listenStarted ) {
				this.listenStarted = true;
				waitNotification.call(this);
			}
			return newSubscription;
		};
		
		this.unregisterSubscription = function (subscription, successCallback) {
			var subscriptionIndex = this.subscriptions.indexOf(subscription);
			if ( subscriptionIndex != -1 ) {
				this.subscriptions[subscriptionIndex].unregister((function (subscriptionIndex, successCallback){
					this.subscriptions.splice(subscriptionIndex, 1);
					successCallback();
				}).bind(this, subscriptionIndex, successCallback))
			}
		}
		
		this.register = function (){
			return client.invoke(
				"/SubscriptionService/CreateSubscriptionChannel", 
				{NotificationQueueSize: notificationQueueSize},
				(function (result){
					this.channelId = result;
					if ( !created )
						this.onCreate.call(this, this.channelId);
					created = true;
				}).bind(this)
			);
		}
		
		this.register.call(this);
		
		var retryFrequency = 10000; //The frequency at which to retry connecting, in milliseconds
		
		var waitNotification = function (lastNotificationId) {
			if( typeof(lastNotificationId)== "undefined" ) {
				lastNotificationId = channelLastNotificationId;
			}
			return client.invoke(
				"/SubscriptionService/WaitNotification",
				{SubscriptionChannel: this.channelId, LastNotificationId: lastNotificationId},
				(function (notifications) {
					for ( var i = 0; i < notifications.length; i++ ) {
						var notification = notifications[i];
						if ( this.subscriptionsDictionary[notification.SubscriptionId] ) {
							this.subscriptionsDictionary[notification.SubscriptionId].onChange(notification.Value.Value);
							if ( notification.Id > channelLastNotificationId )
								channelLastNotificationId = notification.Id;
						}
					}
					waitNotification.call(this);
				}).bind(this)
			).fail(function (request, status, error){
				if ( request.readyState == 4 ){
					//We have reconnected but the server has forgotten our channel
					if (request.getResponseHeader("Content-Type") == "application/json"){
						var woopsaException = JSON.parse(request.responseText);
						if (woopsaException.Type == "WoopsaInvalidSubscriptionChannelException"){
							this.register().done(function (){
								for ( var i = 0; i < this.subscriptions.length; i++ ) {
									this.subscriptions[i].register()
								}
							}.bind(this));
							setTimeout((function (){
								waitNotification.call(this, channelLastNotificationId);
							}).bind(this), retryFrequency);
						}else if (woopsaException.Type == "WoopsaNotificationsLostException"){
							waitNotification.call(this, 0);
						}				
					}
				}else{					
					setTimeout((function (){
						waitNotification.call(this, channelLastNotificationId);
					}).bind(this), retryFrequency);
				}
			}.bind(this));
		}
	};
	
	global.WoopsaClient = function (url, jQuery) {
		var $ = jQuery;
		var subscriptionChannel = null;
		var errorCallbacks = [];
		
		if ( url.lastIndexOf('/') == url.length-1 ) {
			this.url = url;
		} else {
			this.url = url + "/";
		}
		
		this.username = null,
		this.password = null;
		
		this.read = function (path, callback) {
			return $.ajax({
				type: 'GET',
				url: this.url + "read" + path,
				beforeSend: authenticateHeaders.bind(this)
			})
			.done(function (data) {
				callback(data.Value, path);
			})
			.fail(function (request, status, errorThrown){
				raiseError(status, errorThrown);
			});
		};
		
		this.write = function (path, value, callback) {
			return $.ajax({
				type: 'POST',
				url: this.url + 'write' + path,
				beforeSend: authenticateHeaders.bind(this),
				data: {value: value}
			})
			.done(function (data) {
				callback(true, path);
			})
			.fail(function (request, status, errorThrown){
				raiseError(status, errorThrown);
			});
		};
	
		this.meta = function (path, callback) {
			return $.ajax({
				type: 'GET',
				url: this.url + "meta" + path,
				beforeSend: authenticateHeaders.bind(this),
			})
			.done(function (data) {
				callback(data, path);
			})
			.fail(function (request, status, errorThrown){
				raiseError(status, errorThrown);
			});
		};
		
		this.invoke = function (path, arguments, callback, timeout) {
			timeout = timeout || 10000;
			arguments = arguments || {};
			callback = callback || (function (){});
			return $.ajax({
				type: 'POST',
				timeout: timeout,
				beforeSend: authenticateHeaders.bind(this),
				url: this.url + "invoke" + path,
				data: arguments,
				dataType: "text"
			})
			.done(function (data){
				if ( data == "" )
					callback();
				else
					callback(JSON.parse(data).Value);
			})
			.fail(function (request, status, errorThrown){
				raiseError(status, errorThrown);
			});
		};
		
		this.multiRequest = function(requests, callback){
			var internalRequests = {};
			var allArguments = [];
			for(var i = 0; i < requests.length; i++){
				var req = requests[i];
				internalRequests[req.Id] = req;
				allArguments.push({
					Id: req.Id,
					Action: req.Action,
					Path: req.Path,
					Value: req.Value,
					Arguments: req.Arguments
				});
			}
			
			return this.invoke("/MultiRequest", {Requests: JSON.stringify(allArguments)}, (function (data){
				for(var i = 0; i < data.length; i++){
					var response = data[i];
					var internalRequest = internalRequests[response.Id];
					if ( internalRequest.callback )
						internalRequest.callback(response.Result);
				}
				callback(data);
			}).bind(this));
		}
		
		this.createSubscriptionChannel = function (notificationQueueSize, callback) {
			if ( subscriptionChannel != null ) {
				callback.call(subscriptionChannel, subscriptionChannel.channelId);
				return;
			}
			var newChannel = new SubscriptionChannel(this, notificationQueueSize, function (channelId){
				callback.call(this, channelId);
			})
			subscriptionChannel = newChannel;
			return newChannel;
		};
		
		var subscriptionChannelCreating = false;
		var queue = [];
		this.onChange = function (path, callback, monitorInterval, publishInterval) {
			if ( subscriptionChannelCreating ){
				queue.push({
					path: path,
					callback: callback,
					monitorInterval: monitorInterval,
					publishInterval: publishInterval
				});
				return;
			}
			if ( subscriptionChannel == null && !subscriptionChannelCreating ) {
				subscriptionChannelCreating = true;
				this.createSubscriptionChannel(200, (function (){
					this.onChange(path, callback, monitorInterval, publishInterval);
					subscriptionChannelCreating = false;
					for(var i = queue.length-1; i >= 0; i--){
						var elem = queue[i];
						subscriptionChannel.registerSubscription(
							elem.path,
							elem.callback,
							nop,
							elem.monitorInterval,
							elem.publishInterval
						);
						queue.splice(i,1);
					}
				}).bind(this))
			}else{
				subscriptionChannel.registerSubscription(path, callback, nop, monitorInterval, publishInterval);
			}
		};
		
		this.onError = function (callback){
			errorCallbacks.push(callback);
		};
		
		function raiseError(type, errorThrown){
			for ( var i = 0; i < errorCallbacks.length; i++ ) {
				errorCallbacks[i](type, errorThrown);
			}
		}
		
		function authenticateHeaders(xhr){
			if ( this.username != null )
				xhr.setRequestHeader("Authorization", "Basic " + btoa(this.username + ":" + this.password));
		}
	};
})(window);