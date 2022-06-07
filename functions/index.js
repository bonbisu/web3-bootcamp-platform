const functions = require('firebase-functions')
const { sendEmail } = require('./emails')
const { PubSub } = require('@google-cloud/pubsub')
const admin = require('firebase-admin')
const { addDiscordRole } = require('./discord_integration')
const { userCompletedCourse } = require('./lib/checkUserLessons')
const { mint } = require('./mintNFT.js')

admin.initializeApp()

const db = admin.firestore()

const pubsub = new PubSub()

exports.sendEmail = functions.https.onRequest(async (req, resp) => {
  const subject = req.query.subject || '🏕️ Seu primeiro Smart Contract na Ethereum'
  resp.send(await sendEmail(req.query.template, subject, req.query.to))
})

async function docData(collection, doc_id) {
  return (await db.collection(collection).doc(doc_id).get()).data()
}

async function emailParams(cohort) {
  return {
    cohort: await docData('cohorts', cohort.cohort_id),
    course: await docData('courses', cohort.course_id),
  }
}

exports.onCohortSignup = functions.firestore
  .document('users/{userId}')
  .onUpdate(async (change, context) => {
    const previousUserValue = change.before.data()
    const user = change.after.data()
    const previousCohortData = previousUserValue.cohorts.map((item) => item?.cohort_id)
    const userNewCohorts = user.cohorts.filter(
      (item) => !previousCohortData?.includes(item.cohort_id)
    )

    for (let cohortSnapshot of userNewCohorts) {
      const params = emailParams(cohortSnapshot)
      //todo essas funções deveriam ser enfileiradas num pubsub para evitar falhas
      await Promise.all([
        sendEmail('on_cohort_signup.js', params.cohort.email_content.subject, user.email, params),
        addDiscordRole(user?.discord?.id, params.cohort.discord_role),
      ])
    }
  })

exports.onDiscordConnect = functions.firestore
  .document('users/{userId}')
  .onUpdate(async (change, context) => {
    const previousUserValue = change.before.data()
    const newUserValue = change.after.data()

    function userConnectedDiscord() {
      return newUserValue.discord?.id && newUserValue.discord?.id !== previousUserValue.discord?.id
    }

    if (!userConnectedDiscord()) return

    for (let cohortSnapshot of newUserValue.cohorts) {
      const params = {
        cohort: docData('cohorts', cohortSnapshot.cohort_id),
      }
      //todo essas funções deveriam ser enfileiradas num pubsub para evitar falhas
      await Promise.all([addDiscordRole(newUserValue?.discord?.id, params.cohort.discord_role)])
    }
  })

const GRADUATED_ROLE_ID = '985557210794958948'

exports.mintNFT = functions.firestore
  .document('lessons_submissions/{lessonId}')
  .onCreate(async (snap, context) => {
    const createdLesson = snap.data()
    if (createdLesson.lesson !== 'Lesson_2_Finalize_Celebrate.md') return // verificar depois pra pegar a ultima lição dinamicamente ou padronizar este nome para sempre ser a ultima lição

    const cohort = await docData('cohorts', createdLesson.cohort_id)

    if (!userCompletedCourse(createdLesson.user_id, cohort.course_id, db))
      return console.log('Usuário não completou todas as lições')

    const user = await docData('users', createdLesson.user_id)
    const course = await docData('courses', cohort.course_id)

    addDiscordRole(user?.discord?.id, GRADUATED_ROLE_ID)
    await mint(cohort, course.nft_title, user)
  })

exports.sendEmailJob = functions.pubsub.topic("course_day_email").onPublish((message) => {
  const data = JSON.parse(Buffer.from(message.data, "base64"));

  console.log(`Sending message ${data.subject} template ${data.template} to ${data.to}`);

  return sendEmail(data.template, data.subject, data.to, data.params);
});

exports.sendEmailToAllUsersInCohort = functions.https.onRequest(async (req, resp) => {
  db.collection("users")
    .get()
    .then((querySnapshot) => {
      console.log(querySnapshot.size);
      const emails = querySnapshot.docs.map(async (doc) => {
        const user = doc.data();
        const userCohort = user.cohorts.find((cohort) => cohort.cohort_id === req.query.cohort_id);
        if (!userCohort || !user.email) return 0;
        const cohort = await docData("cohorts", userCohort.cohort_id);
        if (cohort) {
          const messageObject = {
            to: user.email,
            template: req.query.template,
            subject: req.query.subject || cohort.email_content.subject,
            params: await emailParams(userCohort),
          }
          const messageBuffer = Buffer.from(JSON.stringify(messageObject), 'utf8')
          pubsub.topic('course_day_email').publishMessage({ data: messageBuffer })
        }
        return 1;
      });
      Promise.all(emails).then((results) => {
        console.log("Sent emails: " + results.reduce((acc, curr) => acc + curr, 0));
      });
    });
  resp.send("OK");
});

exports.addUserToDiscord = functions.https.onRequest(async (req, resp) => {
  addUserToRole(req.query.user_id, req.query.role_id).then((r) =>
    resp.send('OK')
  )
})

exports.inactiveEmail = functions.pubsub.schedule('0 19 * * *').onRun((context) => {
  let cohortObj = {}
  await db.collection('cohorts').get().then(cohorts => {
    cohorts.forEach(async cohort => {
      const data = cohort.data()
      const MS_TO_HOURS = 3.6e+6
      const diff = Math.abs(((new Date(data.kickoffStartTime.toDate()).getTime()) - new Date().getTime()) / MS_TO_HOURS)
      if(diff > 47 && diff < 49) return cohortObj = cohort
    })
  })
  const params = { cohort: cohortObj?.data(), course: (await db.collection('courses').doc(cohortObj?.data().course_id).get()).data() }
  db.collection('users').get().then(users => {
    users.forEach(async user => {
      const userData = user.data()
      const currentCohort = userData.cohorts.find(userCohort => userCohort?.cohort_id === cohortObj?.id)
      const lessons = (await db.collection('lessons_submissions').where('user_id', '==', user.id).where('cohort_id', '==', cohortObj?.id).get())
      console.log(userData.cohorts)
      if(userData.cohorts && currentCohort?.cohort_id === cohortObj?.id && lessons.size == 0) {
        sendEmail('kickoff_email.js', cohortObj.data().email_content.subject, userData.email, params)
      }
    })
  })
})

exports.addAllUsersFromCohortToDiscord = functions.https.onRequest(
  async (req, resp) => {
    const cohort_id = req.query.cohort_id
    const cohort = docData("cohorts", cohort_id);

    if (!cohort) {
      console.log('invalid cohort')
      return resp.send('invalid cohort')
    }

    const users = await db.collection('users').get()

    if (users.empty) {
      console.log('no users to change')
      return resp.send('no users')
    }

    users.forEach(async (doc) => {
      const data = doc.data()
      if (
        data.cohorts &&
        data.cohorts[0] &&
        data?.discord?.id &&
        data.cohorts[0].cohort_id === cohort_id
      ) {
        console.log(
          `Adicionando role ${cohort.discord_role} do curso no discord: ${data.discord.username}`
        )
        try {
          await addDiscordRole(data.discord.id, cohort.discord_role)
        } catch (exception) {
          console.log(exception)
        }
      }
    })
    resp.send('OK')
  }
)
