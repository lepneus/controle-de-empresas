importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBGS1CZD-jgQsLcL7wlnXqBZbodrAC-cIQ",
  authDomain: "le-pneus.firebaseapp.com",
  projectId: "le-pneus",
  storageBucket: "le-pneus.firebasestorage.app",
  messagingSenderId: "301697438039",
  appId: "1:301697438039:web:a7a36ebae356868e916e12",
  measurementId: "G-4V5MF7GWMN"
});

const messaging=firebase.messaging();

messaging.onBackgroundMessage(payload=>{
  const data=payload.data||{};
  const title=data.title||'Le Pneus';
  const options={
    body:data.body||'Você tem uma atualização nas Contas a Pagar.',
    icon:'./icon-192.png',
    badge:'./icon-192.png',
    tag:data.tag||'lepneus-contas',
    renotify:true,
    data:{url:data.url||'./?open=financeiro'}
  };
  return self.registration.showNotification(title,options);
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const target=event.notification?.data?.url||'./?open=financeiro';
  event.waitUntil((async()=>{
    const all=await clients.matchAll({type:'window',includeUncontrolled:true});
    for(const c of all){
      if('focus' in c){
        try{await c.navigate(target)}catch(e){}
        return c.focus();
      }
    }
    if(clients.openWindow)return clients.openWindow(target);
  })());
});
