const firebaseConfig = {
  apiKey: "AIzaSyChbqOpu-VoGGkmjYptCl0usloYQ1FtSVM",
  authDomain: "emploi-du-temps-1644e.firebaseapp.com",
  projectId: "emploi-du-temps-1644e",
  storageBucket: "emploi-du-temps-1644e.firebasestorage.app",
  messagingSenderId: "84122131462",
  appId: "1:84122131462:web:0648cc735811498c357787",
  measurementId: "G-1Q81J5JYX8",
};

firebase.initializeApp(firebaseConfig);
export const db = firebase.firestore();
db.settings({
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false,
  merge: true,
});

export const addDoc = (collectionRef, data) => collectionRef.add(data);
export const collection = (dbRef, name) => dbRef.collection(name);
export const deleteDoc = (docRef) => docRef.delete();
export const doc = (dbRef, name, id) => dbRef.collection(name).doc(id);
export const onSnapshot = (queryRef, callback) => queryRef.onSnapshot(callback);
export const setDoc = (docRef, data) => docRef.set(data);
export const updateDoc = (docRef, data) => docRef.update(data);
export const serverTimestamp = () => firebase.firestore.FieldValue.serverTimestamp();
