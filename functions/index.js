const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

// Scheduled function: Check for upcoming classes every minute
exports.checkClassReminders = functions.pubsub
  .schedule('every 1 minutes')
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    console.log('Checking for class reminders...');

    try {
      // Get tutor data
      const tutorDoc = await db.collection('users').doc('tutor').get();

      if (!tutorDoc.exists) {
        console.log('No tutor document found');
        return null;
      }

      const tutorData = tutorDoc.data();
      const fcmToken = tutorData.fcmToken;
      const classes = tutorData.classes || [];

      if (!fcmToken) {
        console.log('No FCM token found');
        return null;
      }

      // Get current time in IST
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
      const istNow = new Date(now.getTime() + istOffset);
      const todayStr = istNow.toISOString().split('T')[0];
      const currentHour = istNow.getUTCHours();
      const currentMinute = istNow.getUTCMinutes();

      // Check each class
      for (const cls of classes) {
        if (cls.date !== todayStr || cls.cancelled) continue;

        const [classHour, classMinute] = cls.start.split(':').map(Number);

        // Calculate minutes until class
        const classMinutes = classHour * 60 + classMinute;
        const currentMinutes = currentHour * 60 + currentMinute;
        const minutesUntil = classMinutes - currentMinutes;

        // Send reminder 15 minutes before
        if (minutesUntil >= 14 && minutesUntil <= 16) {
          const notificationId = `${cls.student}_${cls.date}_${cls.start}`;

          // Check if already notified
          const notifiedDoc = await db.collection('notified').doc(notificationId).get();
          if (notifiedDoc.exists) {
            console.log(`Already notified for ${notificationId}`);
            continue;
          }

          // Send notification
          const message = {
            notification: {
              title: `🔔 ${cls.student}'s class in 15 min!`,
              body: `⏰ ${formatTime(cls.start)} - ${formatTime(cls.end)} - Get ready!`
            },
            data: {
              type: 'class_reminder',
              student: cls.student,
              time: cls.start,
              tag: `class-${notificationId}`
            },
            android: {
              priority: 'high',
              notification: {
                channelId: 'class_reminders',
                priority: 'high',
                defaultVibrateTimings: true,
                defaultSound: true
              }
            },
            webpush: {
              headers: {
                Urgency: 'high'
              },
              notification: {
                requireInteraction: true,
                vibrate: [300, 100, 300, 100, 300]
              }
            },
            token: fcmToken
          };

          try {
            await messaging.send(message);
            console.log(`Sent reminder for ${cls.student}'s class`);

            // Mark as notified
            await db.collection('notified').doc(notificationId).set({
              notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
              type: 'class_reminder'
            });
          } catch (sendError) {
            console.error('Error sending notification:', sendError);
          }
        }
      }

      return null;
    } catch (error) {
      console.error('Error in checkClassReminders:', error);
      return null;
    }
  });

// Scheduled function: End of day payment reminder (8 PM IST)
exports.endOfDayReminder = functions.pubsub
  .schedule('0 20 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    console.log('Sending end of day reminder...');

    try {
      const tutorDoc = await db.collection('users').doc('tutor').get();

      if (!tutorDoc.exists) {
        console.log('No tutor document found');
        return null;
      }

      const tutorData = tutorDoc.data();
      const fcmToken = tutorData.fcmToken;

      if (!fcmToken) {
        console.log('No FCM token found');
        return null;
      }

      const message = {
        notification: {
          title: '📝 End of Day Reminder',
          body: 'Don\'t forget to update your classes and collect payments!'
        },
        data: {
          type: 'end_of_day',
          tag: 'end-of-day-' + Date.now()
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'reminders',
            priority: 'high',
            defaultVibrateTimings: true,
            defaultSound: true
          }
        },
        webpush: {
          headers: {
            Urgency: 'high'
          },
          notification: {
            requireInteraction: true,
            vibrate: [300, 100, 300]
          }
        },
        token: fcmToken
      };

      await messaging.send(message);
      console.log('End of day reminder sent');

      return null;
    } catch (error) {
      console.error('Error sending end of day reminder:', error);
      return null;
    }
  });

// Scheduled function: Second reminder at 9 PM if still pending tasks
exports.endOfDayReminderFollowUp = functions.pubsub
  .schedule('0 21 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    console.log('Sending follow-up reminder...');

    try {
      const tutorDoc = await db.collection('users').doc('tutor').get();

      if (!tutorDoc.exists) return null;

      const tutorData = tutorDoc.data();
      const fcmToken = tutorData.fcmToken;

      if (!fcmToken) return null;

      const message = {
        notification: {
          title: '💰 Payment Reminder',
          body: 'Have you collected all payments for today\'s classes?'
        },
        data: {
          type: 'payment_reminder',
          tag: 'payment-' + Date.now()
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'reminders',
            priority: 'high'
          }
        },
        webpush: {
          headers: {
            Urgency: 'high'
          },
          notification: {
            requireInteraction: true
          }
        },
        token: fcmToken
      };

      await messaging.send(message);
      console.log('Follow-up reminder sent');

      return null;
    } catch (error) {
      console.error('Error sending follow-up reminder:', error);
      return null;
    }
  });

// Helper function to format time
function formatTime(time24) {
  const [hours, minutes] = time24.split(':');
  const h = parseInt(hours);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${minutes} ${ampm}`;
}

// Clean up old notifications daily
exports.cleanupNotifications = functions.pubsub
  .schedule('0 6 * * *')
  .timeZone('Asia/Kolkata')
  .onRun(async (context) => {
    console.log('Cleaning up old notifications...');

    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const oldNotifications = await db.collection('notified')
        .where('notifiedAt', '<', yesterday)
        .get();

      const batch = db.batch();
      oldNotifications.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      console.log(`Deleted ${oldNotifications.size} old notification records`);

      return null;
    } catch (error) {
      console.error('Error cleaning up notifications:', error);
      return null;
    }
  });
