export function createEmptyStudentProfile() {
  return {
    personalInfo: {
      fullName: null,
      email: null,
      phone: null,
      address: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
      dateOfBirth: null,
      intendedMajor: null,
      ethnicity: null
    },
    academics: {
      gpa: null,
      graduationYear: null,
      schoolName: null,
      gradeLevel: null,
      schools: []
    },
    activities: [],
    awards: [],
    essays: [],
    extractionConfidence: {},
    fieldProvenance: {},
    conflicts: []
  };
}
