export const AVATARS = {
  crow: {
    key: "crow",
    name: "Crow",
    idleUrl: "https://gist.github.com/user-attachments/assets/d83d977e-c6bb-4a7c-aa8a-f3c64da44778",
    speakingUrl: "https://gist.github.com/user-attachments/assets/03bc37b1-1603-4b3a-8f8e-1d60ae7e2f27",
    previewUrl: "https://gist.github.com/user-attachments/assets/03bc37b1-1603-4b3a-8f8e-1d60ae7e2f27",
    sortOrder: 1
  },
  dog: {
    key: "dog",
    name: "Dog",
    idleUrl: "https://gist.github.com/user-attachments/assets/4a70b2ea-52b7-4601-805c-cb03fbe9613d",
    speakingUrl: "https://gist.github.com/user-attachments/assets/ca21c29f-c7e0-427d-8dd8-c66d86dcdb92",
    previewUrl: "https://gist.github.com/user-attachments/assets/ca21c29f-c7e0-427d-8dd8-c66d86dcdb92",
    sortOrder: 2
  },
  talldog: {
    key: "talldog",
    name: "Tall Dog",
    idleUrl: "https://gist.github.com/user-attachments/assets/3b13e703-b822-4a67-aacf-14b603ca0498",
    speakingUrl: "https://gist.github.com/user-attachments/assets/afb395f1-591f-42aa-aa0c-431187ffea55",
    previewUrl: "https://gist.github.com/user-attachments/assets/afb395f1-591f-42aa-aa0c-431187ffea55",
    sortOrder: 3
  },
  raccoon: {
    key: "raccoon",
    name: "Raccoon",
    idleUrl: "https://gist.github.com/user-attachments/assets/603ccd09-88b6-4482-a28b-65884e3026c6",
    speakingUrl: "https://gist.github.com/user-attachments/assets/a7e2d283-0c96-4794-b749-998a8286db80",
    previewUrl: "https://gist.github.com/user-attachments/assets/a7e2d283-0c96-4794-b749-998a8286db80",
    sortOrder: 4
  },
  cat: {
    key: "cat",
    name: "Cat",
    idleUrl: "https://gist.github.com/user-attachments/assets/bdc05d24-d015-4d47-876a-4a130b7421bc",
    speakingUrl: "https://gist.github.com/user-attachments/assets/504ab97c-b706-47a7-9f6e-40e9a269e87a",
    previewUrl: "https://gist.github.com/user-attachments/assets/504ab97c-b706-47a7-9f6e-40e9a269e87a",
    sortOrder: 5
  },
  hmm: {
    key: "hmm",
    name: "Hmm",
    idleUrl: "https://gist.github.com/user-attachments/assets/2aa8a87d-2cb1-4b7e-bbe8-4360e4b4524b",
    speakingUrl: "https://gist.github.com/user-attachments/assets/9cde84b3-877d-41b0-992e-b2d24d7559ce",
    previewUrl: "https://gist.github.com/user-attachments/assets/9cde84b3-877d-41b0-992e-b2d24d7559ce",
    sortOrder: 6
  }
};

export function getAvatarEntries() {
  return Object.values(AVATARS).sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getAvatarByKey(key) {
  return AVATARS[key] ?? null;
}
